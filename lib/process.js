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
 * OpenCode 配置、凭据与会话从不被读写。
 *
 * @module dsh-opencode-sdk-bridge/process
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { findBinary } from './platform.js';
import { EventHub, makeClient, probeReady } from './sdk.js';
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
 */
export const NATIVE_PERMISSIONS = {
    '*': 'ask',
    question: 'deny',
    websearch: 'deny',
    codesearch: 'deny',
    webfetch: 'deny',
    task: 'deny',
    plan_enter: 'deny',
    plan_exit: 'deny',
    todowrite: 'deny',
};
/** 会话级权限条目（POST /session 的 wire 扩展字段）。 */
export function sessionPermissionRules() {
    return Object.entries(NATIVE_PERMISSIONS).map(([permission, action]) => ({
        permission,
        pattern: '*',
        action,
    }));
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
};
export const BRIDGE_AGENT = 'sdk-bridge';
export const CHAT_AGENT = 'sdk-chat';
/** 只有这些普通 OS/网络变量会进入子进程，绝不透传任何 provider 密钥。 */
const FORWARDED_ENV = [
    'PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC',
];
/** Node 风格的 XDG 根，全部落在插件数据目录下。 */
const XDG_ROOTS = ['config', 'data', 'cache', 'state'];
/**
 * stdout 端口嗅探要匹配的形状：
 *   opencode server listening on http://127.0.0.1:49764
 */
const PORT_PATTERN = /opencode server listening on https?:\/\/127\.0\.0\.1:(\d+)/;
export const STARTUP_TIMEOUT_MS = 60_000;
export const READY_TIMEOUT_MS = 20_000;
const GRACEFUL_KILL_MS = 4_000;
/** 一个托管中的 OpenCode 运行时。 */
export class OpenCodeRuntime {
    url;
    password;
    client;
    child;
    version;
    hub;
    exitHook = () => { this.child.kill('SIGKILL'); };
    constructor(url, password, client, child, version, hub) {
        this.url = url;
        this.password = password;
        this.client = client;
        this.child = child;
        this.version = version;
        this.hub = hub;
        // 宿主进程硬退出的最后防线（正常路径走 ctx.effect → stop()）。
        process.once('exit', this.exitHook);
    }
    /** 优雅终止：先 SIGTERM，超时再 SIGKILL；幂等。 */
    async stop() {
        this.hub.stop();
        process.off('exit', this.exitHook);
        if (this.child.exitCode !== null || this.child.signalCode !== null)
            return;
        this.child.kill('SIGTERM');
        await Promise.race([
            new Promise(resolve => this.child.once('exit', () => resolve())),
            new Promise(resolve => setTimeout(resolve, GRACEFUL_KILL_MS)),
        ]);
        if (this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill('SIGKILL');
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
export async function startRuntime(options) {
    const binary = await findBinary(options.binaryPath);
    options.log?.(`使用 OpenCode ${binary.version}（${binary.source}）`);
    const root = path.join(options.dataDir, 'opencode');
    for (const dir of XDG_ROOTS) {
        await fsp.mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
    }
    // 子进程环境显式构建：只透传普通 OS/网络设置。
    const env = {};
    for (const key of FORWARDED_ENV) {
        if (process.env[key])
            env[key] = process.env[key];
    }
    for (const dir of XDG_ROOTS) {
        env[`XDG_${dir.toUpperCase()}_HOME`] = path.join(root, dir);
    }
    const password = randomBytes(24).toString('hex');
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
    });
    const projectDir = path.join(root, 'project');
    await fsp.mkdir(projectDir, { recursive: true });
    // 后台静默拉起；端口交给操作系统随机分配（--port 0），真实端口从日志嗅探。
    const requestedPort = options.port ?? 0;
    const child = spawn(binary.file, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(requestedPort)], { cwd: projectDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // —— 动态端口嗅探 ——
    const port = await sniffPort(child, options.logStream, requestedPort);
    const url = `http://127.0.0.1:${port}`;
    options.log?.(`端口嗅探成功：${url}`);
    // 官方 SDK 客户端：Basic 认证，原生 OpenCode 客户端同款。
    const client = makeClient(url, password);
    await probeReady(client, READY_TIMEOUT_MS);
    options.log?.('SDK 通道就绪');
    const hub = new EventHub(client, error => {
        options.log?.(`事件流错误，正在重连：${error.message}`);
        options.logStream.write(`${new Date().toISOString()} event stream error: ${error.message}\n`);
    });
    hub.start();
    return new OpenCodeRuntime(url, password, client, child, binary.version, hub);
}
/**
 * 监听子进程输出，用正则从
 * `opencode server listening on http://127.0.0.1:xxxxx` 里取出真实端口。
 *
 * - 固定端口的配置也会被校验：日志里报了别的端口，以日志为准。
 * - 日志行会原样落盘（滚动缓冲保护跨 chunk 的行分裂）。
 * - 子进程提前退出 / spawn 失败 / 超时都会立刻失败并终止子进程。
 */
function sniffPort(child, logStream, requestedPort) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let pending = '';
        const settle = (error, value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error) {
                if (child.exitCode === null && child.signalCode === null)
                    child.kill('SIGKILL');
                reject(error);
            }
            else {
                resolve(value);
            }
        };
        const timer = setTimeout(() => {
            settle(new Error(`等待 OpenCode 端口日志超时（${STARTUP_TIMEOUT_MS / 1000}s）`));
        }, STARTUP_TIMEOUT_MS);
        timer.unref?.();
        const onData = (chunk) => {
            const text = typeof chunk === 'string' ? chunk : chunk.toString();
            logStream.write(text);
            // 滚动缓冲：一行端口日志可能被拆在两个 chunk 里。
            pending = (pending + text).slice(-512);
            const match = PORT_PATTERN.exec(pending);
            if (match)
                settle(undefined, Number(match[1]));
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.once('exit', code => {
            settle(new Error(`opencode serve 启动即退出（退出码 ${code}）`));
        });
        child.once('error', error => settle(error));
    });
}
