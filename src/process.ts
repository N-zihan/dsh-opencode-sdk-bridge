/**
 * 托管 OpenCode 运行时：解析二进制、隔离地启动 `opencode serve` 子进程、从
 * stdout 嗅探真实监听端口、用官方 SDK 建立连接、并在插件停用 / DSH 退出时优雅
 * 终止子进程。
 *
 * 为什么必须是真实进程：OpenCode Zen 直接调免费模型会返回
 * `FreeTierError: OpenCode's free tier can only be used from within OpenCode`，
 * 改 header / UA 都没用，只有来自真实 OpenCode 运行时的流量会被接受。所以这
 * 里没有任何协议伪装——跑官方二进制、说官方协议。
 *
 * 隔离：独立的 XDG 根（在插件数据目录下）、每次启动随机生成 server 密码、禁
 * 用 autoupdate/share/project-config，只透传普通 OS/网络变量。用户自己的
 * OpenCode 数据库、会话与配置从不读写；唯一例外是 auth.json——用户自己的
 * OpenCode 登录凭据会复制进隔离根（免费层闸门要求登录态，见
 * NATIVE_PERMISSIONS 注释与 syncUserAuth）。
 *
 * @module dsh-opencode-sdk-bridge/process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import type { WriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { findBinary } from './platform.js'
import { EventHub, makeClient, probeReady } from './sdk.js'

/**
 * 原生权限策略 —— 这是免费层放行的关键，不是装饰。
 *
 * 实测矩阵（dsh-opencode-xdbridge 项目 2026-09-29 对真实 `opencode serve` 的
 * A/B/C/D 测量）：
 *   permission {'*':'ask'}   → 请求放行
 *   permission {'*':'deny'}  → FreeTierError 403
 *   agent.tools {'*':false}  → FreeTierError 403
 *   agent permission deny    → FreeTierError 403
 * 所以 '*' 保持 ask：每个原生动作都会被后端显式拒绝，但在上游看来这就是一次
 * 普通的 OpenCode 会话。
 *
 * 2026-10-18 追加实测：仅有真实运行时已不再放行——上游免费层闸门从这晚开始
 * 同时要求登录凭据（用户在 `opencode auth login` 里登录 OpenCode 后落在本机
 * `~/.local/share/opencode/auth.json` 的条目）。隔离运行时缺它，首个 stream
 * 就被 FreeTierError 拒绝（同一晚 dsh-opencode-xdbridge 的隔离运行时同样全
 * 部被拒，可交叉验证）。对策见 syncUserAuth。
 */
export const NATIVE_PERMISSIONS: Readonly<Record<string, 'ask' | 'deny'>> = {
  '*': 'ask',
  question: 'deny',
  websearch: 'deny',
  codesearch: 'deny',
  webfetch: 'deny',
  task: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
  todowrite: 'deny',
}

/** 会话级权限条目（POST /session 的 wire 扩展字段）。 */
export function sessionPermissionRules(): Array<{ permission: string; pattern: string; action: 'ask' | 'deny' }> {
  return Object.entries(NATIVE_PERMISSIONS).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }))
}

/** 装进隔离运行时的 agent：只推理，不行动。 */
export const ISOLATED_AGENTS = {
  /** 信封模式：把回复/外部工具调用打包成 JSON。 */
  'sdk-bridge': {
    mode: 'primary',
    description: 'External client inference only',
    prompt: 'You are the reasoning component of an external assistant. Never invoke native OpenCode tools. Describe external tool calls only in the requested JSON response. The external client owns execution and supplies tool results on the next request.',
    permission: NATIVE_PERMISSIONS,
  },
  /** 纯文本模式：给不支持工具调用的模型。 */
  'sdk-chat': {
    mode: 'primary',
    description: 'Text-only external conversation',
    prompt: 'Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.',
    permission: NATIVE_PERMISSIONS,
  },
} as const

export const BRIDGE_AGENT = 'sdk-bridge'
export const CHAT_AGENT = 'sdk-chat'

/** 只有这些普通 OS/网络变量会进入子进程，绝不透传任何 provider 密钥。 */
const FORWARDED_ENV = [
  'PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC',
] as const

/** Node 风格的 XDG 根，全部落在插件数据目录下。 */
const XDG_ROOTS = ['config', 'data', 'cache', 'state'] as const

/**
 * stdout 端口嗅探要匹配的形状：
 *   opencode server listening on http://127.0.0.1:49764
 */
const PORT_PATTERN = /opencode server listening on https?:\/\/127\.0\.0\.1:(\d+)/

export const STARTUP_TIMEOUT_MS = 60_000
export const READY_TIMEOUT_MS = 20_000
const GRACEFUL_KILL_MS = 4_000

export interface RuntimeStartOptions {
  dataDir: string
  binaryPath?: string
  /** 固定 opencode serve 端口；0（默认）= 操作系统随机分配，靠嗅探获取。 */
  port?: number
  logStream: WriteStream
  log?: (line: string) => void
}

/** 一个托管中的 OpenCode 运行时。 */
export class OpenCodeRuntime {
  exitHook = () => { this.child.kill('SIGKILL') }

  constructor(
    readonly url: string,
    readonly password: string,
    readonly client: OpencodeClient,
    readonly child: ChildProcess,
    readonly version: string,
    readonly hub: EventHub,
  ) {
    // 宿主进程硬退出的最后防线（正常路径走 ctx.effect → stop()）。
    process.once('exit', this.exitHook)
  }

  /** 优雅终止：先 SIGTERM，超时再 SIGKILL；幂等。 */
  async stop(): Promise<void> {
    this.hub.stop()
    process.off('exit', this.exitHook)
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>(resolve => this.child.once('exit', () => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, GRACEFUL_KILL_MS)),
    ])
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL')
    }
  }
}

/**
 * 启动隔离的 `opencode serve` 并等到 SDK 通道真正可用。
 *
 * 流程：解析二进制 → 建 XDG 根 → 组装最小环境（含
 * OPENCODE_CONFIG_CONTENT 显式声明 permission: {'*':'ask'}）→ 后台静默拉起
 * 子进程 → 从 stdout/stderr 里嗅探真实端口 → SDK 客户端 + 健康检查 → 事件总线。
 */
export async function startRuntime(options: RuntimeStartOptions): Promise<OpenCodeRuntime> {
  const binary = await findBinary(options.binaryPath)
  options.log?.(`使用 OpenCode ${binary.version}（${binary.source}）`)

  const root = path.join(options.dataDir, 'opencode')
  for (const dir of XDG_ROOTS) {
    await fsp.mkdir(path.join(root, dir), { recursive: true, mode: 0o700 })
  }

  await syncUserAuth(root, options.log)

  // 子进程环境显式构建：只透传普通 OS/网络设置。
  const env: Record<string, string> = {}
  for (const key of FORWARDED_ENV) {
    if (process.env[key]) env[key] = process.env[key]
  }
  for (const dir of XDG_ROOTS) {
    env[`XDG_${dir.toUpperCase()}_HOME`] = path.join(root, dir)
  }

  const password = randomBytes(24).toString('hex')
  Object.assign(env, {
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    // 显式声明权限策略：'*' = ask（免费层放行的唯一形态），危险原生工具直接 deny。
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: NATIVE_PERMISSIONS,
      autoupdate: false,
      share: 'disabled',
      agent: ISOLATED_AGENTS,
    }),
  })

  const projectDir = path.join(root, 'project')
  await fsp.mkdir(projectDir, { recursive: true })

  // 后台静默拉起；端口交给操作系统随机分配（--port 0），真实端口从日志嗅探。
  const requestedPort = options.port ?? 0
  const child = spawn(
    binary.file,
    ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(requestedPort)],
    { cwd: projectDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  // —— 动态端口嗅探 ——
  const port = await sniffPort(child, options.logStream, requestedPort)
  const url = `http://127.0.0.1:${port}`
  options.log?.(`端口嗅探成功：${url}`)

  // 官方 SDK 客户端：Basic 认证，原生 OpenCode 客户端同款。
  const client = makeClient(url, password)
  await probeReady(client, READY_TIMEOUT_MS)
  options.log?.('SDK 通道就绪')

  const hub = new EventHub(client, error => {
    options.log?.(`事件流错误，正在重连：${error.message}`)
    options.logStream.write(`${new Date().toISOString()} event stream error: ${error.message}\n`)
  })
  hub.start()

  return new OpenCodeRuntime(url, password, client, child, binary.version, hub)
}

/**
 * 把用户自己的 OpenCode 登录凭据复制进隔离根。
 *
 * opencode 运行时从 `$XDG_DATA_HOME/opencode/auth.json` 读取本机存储的凭据；
 * 宿主进程不设 XDG_DATA_HOME，所以用户自己的那份在
 * `~/.local/share/opencode/auth.json`。上游免费层闸门（2026-10-18 起）在
 * “真实运行时”之外还要求这份登录态，缺失即 FreeTierError。
 *
 * 这里只复制这一个文件：密钥不进环境变量、不进日志、不出网。用户没登录时
 * 不会阻塞启动——只留一行提示（此时免费层仍会拒绝，但原因可查）。
 */
async function syncUserAuth(root: string, log?: (line: string) => void): Promise<void> {
  const source = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json')
    : path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
  const target = path.join(root, 'data', 'opencode', 'auth.json')
  try {
    await fsp.copyFile(source, target)
    log?.('已同步用户 OpenCode 登录凭据（auth.json，内容不记录）')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      log?.(`未找到用户 OpenCode 登录凭据（${source}）：免费层大概率继续 FreeTierError，请先在终端跑 opencode auth login`)
    } else {
      log?.(`同步 OpenCode 凭据失败（${code ?? String(error)}），免费层可能继续拒绝`)
    }
  }
}

/**
 * 监听子进程输出，用正则从
 * `opencode server listening on http://127.0.0.1:xxxxx` 里取出真实端口。
 *
 * - 固定端口的配置也会被校验：日志里报了别的端口，以日志为准。
 * - 日志行会原样落盘（滚动缓冲保护跨 chunk 的行分裂）。
 * - 子进程提前退出 / spawn 失败 / 超时都会立刻失败并终止子进程。
 */
function sniffPort(child: ChildProcess, logStream: WriteStream, requestedPort: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false
    let pending = ''

    const settle = (error?: Error, value?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        reject(error)
      } else {
        resolve(value!)
      }
    }

    const timer = setTimeout(() => {
      settle(new Error(`等待 OpenCode 端口日志超时（${STARTUP_TIMEOUT_MS / 1000}s）`))
    }, STARTUP_TIMEOUT_MS)
    timer.unref?.()

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString()
      logStream.write(text)
      // 滚动缓冲：一行端口日志可能被拆在两个 chunk 里。
      pending = (pending + text).slice(-512)
      const match = PORT_PATTERN.exec(pending)
      if (match) settle(undefined, Number(match[1]))
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', code => {
      settle(new Error(`opencode serve 启动即退出（退出码 ${code}）`))
    })
    child.once('error', error => settle(error))
  })
}
