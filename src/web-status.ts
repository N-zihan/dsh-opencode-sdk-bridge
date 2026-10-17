/**
 * 支撑设置页的同源 HTTP 路由。
 *
 * 只回答回环浏览器请求，绝不携带运行时的 server 密码。读操作是 GET，每个
 * 动作都是显式 POST。通过 `ctx.inject(['webServer'], …)` 挂载，启动顺序不会
 * 让注册消失；`webServer` 是可选服务，无头 profile 不挂这些路由，provider
 * 照常服务模型。
 *
 * @module dsh-opencode-sdk-bridge/web-status
 */

import type { Context } from '@deepseek-ai/cordis'

/** 本插件状态路由的公共前缀。 */
export const STATUS_PATH = '/plugins/dsh-opencode-sdk-bridge/status'
export const REFRESH_PATH = '/plugins/dsh-opencode-sdk-bridge/models/refresh'
export const RESTART_PATH = '/plugins/dsh-opencode-sdk-bridge/runtime/restart'
export const GATEWAY_PATH = '/plugins/dsh-opencode-sdk-bridge/gateway'

/** 单个请求体上限。 */
const BODY_LIMIT = 64 * 1024

function json(res: any, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** 返回给浏览器前先截断的一行错误消息。 */
function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

/** 请求是否来自本地 DSH UI（浏览器 POST 会带 Origin；curl 不带，直接放行）。 */
function loopbackOrigin(req: any): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  try {
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/** 读取并解析有上限的 JSON 请求体。 */
async function readJson(req: any): Promise<any> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > BODY_LIMIT) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  if (bytes === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export interface BridgeStatusDeps {
  /** 当前状态文档。 */
  status: () => Record<string, unknown>
  /** 重读免费模型名单。 */
  refresh: () => Promise<{ enriched: boolean; visible: number }>
  /** 重启托管运行时。 */
  restart: () => Promise<{ visible: number }>
  /** 网关直连信息（gateway.json 的内容）。 */
  gateway: () => Record<string, unknown> | undefined
}

/** 挂载本插件拥有的全部路由。 */
export function registerBridgeStatusRoute(ctx: Context, deps: BridgeStatusDeps): void {
  ctx.effect(() => {
    const disposers: Array<() => void> = []

    const route = (path: string, method: string, handler: (req: any, res: any) => Promise<void>) => {
      disposers.push((ctx as any).webServer.register({
        kind: 'exact',
        path,
        handler: async (req: any, res: any) => {
          if (req.method !== method) return json(res, 405, { error: 'method not allowed' })
          if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
          try {
            await handler(req, res)
          } catch (error) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }))
    }

    route(STATUS_PATH, 'GET', async (_req, res) => {
      json(res, 200, deps.status())
    })

    route(REFRESH_PATH, 'POST', async (req, res) => {
      await readJson(req)
      const result = await deps.refresh()
      json(res, 200, { ok: true, ...result })
    })

    route(RESTART_PATH, 'POST', async (req, res) => {
      await readJson(req)
      const result = await deps.restart()
      json(res, 200, { ok: true, ...result })
    })

    route(GATEWAY_PATH, 'GET', async (_req, res) => {
      const info = deps.gateway()
      if (info === undefined) return json(res, 503, { error: 'not ready' })
      json(res, 200, info)
    })

    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 已释放 */ }
      }
    }
  })
}
