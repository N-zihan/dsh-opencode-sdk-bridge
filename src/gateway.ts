/**
 * 回环 OpenAI 兼容端点。
 *
 * pi-ai 的 provider 指向这里（从而 DSH 的请求在这里被拦截并经 SDK 转发），外
 * 部工具也可以拿 data 目录里 gateway.json 中的 url/token 直连。
 *
 * 安全模型（回环 Host/Origin 校验、常量时间 bearer 比较、随机端口、进程内随机
 * 密钥、请求体上限）与其他回环型 Harness provider 的既定约定一致。
 *
 * 流式输出的节奏：
 *  - 仅对话模型：文本增量实时直发（真正的 token 级流）；
 *  - 信封模型：先发 SSE 头与 role（让客户端脱离"等待"）、心跳注释保活，信封
 *    校验通过后一次性发出内容/工具调用——未校验的工具调用决不提前交出去。
 *
 * @module dsh-opencode-sdk-bridge/gateway
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TurnProgress } from './backend.js'
import { clientModelID, type CatalogModel } from './models.js'
import { prepare, sendSSE, type ChatCompletion, type PreparedRequest } from './protocol.js'
import { BridgeError } from './protocol.js'

const REQUEST_BODY_LIMIT = 8 * 1024 * 1024
const HEARTBEAT_MS = 10_000

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/** Host 必须指名回环：在路由前就丢弃 DNS 重绑定尝试。 */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/** Origin 若存在必须是回环；非浏览器客户端不发 Origin，直接放行。 */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function errorBody(message: string, type = 'invalid_request_error', code?: string) {
  return { error: { message, type, ...(code ? { code } : {}) } }
}

/** 常量时间 bearer 比较。 */
function authorized(req: IncomingMessage, key: string): boolean {
  const actual = Buffer.from(req.headers.authorization || '')
  const expected = Buffer.from(`Bearer ${key}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > REQUEST_BODY_LIMIT) throw new BridgeError('请求体超过 8 MB', 413, 'payload_too_large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    throw new BridgeError('请求体不是合法 JSON', 400, 'invalid_json')
  }
}

export interface GatewayLogger {
  info?: (text: string) => void
  warn?: (text: string) => void
  error?: (text: string) => void
}

export interface GatewayCompleteMeta {
  activity?: (progress: TurnProgress) => void
}

export interface GatewayOptions {
  complete: (request: PreparedRequest, signal: AbortSignal | undefined, meta: GatewayCompleteMeta) => Promise<ChatCompletion>
  getModels: () => CatalogModel[]
  refresh?: (modelID?: string) => Promise<unknown>
  logger?: GatewayLogger
  /** 固定网关端口；0（默认）= 随机。 */
  port?: number
}

export interface Gateway {
  server: Server
  baseUrl: () => string
  token: () => string
  close: () => Promise<void>
}

export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const key = randomBytes(32).toString('hex')
  let origin: string | undefined

  const server = createServer(async (req, res) => {
    try {
      // 浏览器页面永远不允许到达这个端点，即使在回环上。
      if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
        return writeJson(res, 403, errorBody('仅允许本机回环访问', 'permission_error'))
      }
      if (!authorized(req, key)) {
        return writeJson(res, 401, errorBody('需要本地网关 API key', 'authentication_error'))
      }

      const route = new URL(req.url ?? '/', 'http://127.0.0.1').pathname

      if (req.method === 'GET' && route === '/health') {
        return writeJson(res, 200, { ok: true, models: options.getModels().length })
      }
      if (req.method === 'GET' && route === '/v1/models') {
        // wire id 就是 provider 作用域的 id：在这里列出模型的客户端可以直接回呼。
        return writeJson(res, 200, {
          object: 'list',
          data: options.getModels().map(model => ({
            id: model.id,
            object: 'model',
            owned_by: 'opencode',
            name: clientModelID(model),
          })),
        })
      }
      if (req.method === 'POST' && route === '/admin/refresh') {
        await options.refresh?.()
        return writeJson(res, 200, { ok: true, models: options.getModels().length })
      }
      if (req.method !== 'POST' || route !== '/v1/chat/completions') {
        return writeJson(res, 404, errorBody('未找到该路径', 'not_found'))
      }

      const body = await readBody(req)
      const request = prepare(body, options.getModels())

      const controller = new AbortController()
      res.on('close', () => { if (!res.writableEnded) controller.abort() })

      // —— 流式状态 ——
      const streamStart = { id: `chatcmpl-${randomBytes(16).toString('hex')}`, created: Math.floor(Date.now() / 1000) }
      let headersSent = false
      let roleSent = false
      let sentChars = 0
      let heartbeat: ReturnType<typeof setInterval> | undefined

      const openStream = (note: string): void => {
        if (headersSent || controller.signal.aborted || res.destroyed || res.writableEnded) return
        headersSent = true
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        res.write(`: ${note}\n\n`)
        heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': waiting\n\n')
        }, HEARTBEAT_MS)
        heartbeat.unref?.()
      }

      const sendRole = (): void => {
        if (roleSent || controller.signal.aborted || res.destroyed || res.writableEnded) return
        openStream('streaming')
        roleSent = true
        res.write(`data: ${JSON.stringify({
          ...streamStart,
          object: 'chat.completion.chunk',
          model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })}\n\n`)
      }

      const writeChunk = (delta: Record<string, unknown>): void => {
        if (controller.signal.aborted || res.destroyed || res.writableEnded) return
        res.write(`data: ${JSON.stringify({
          ...streamStart,
          object: 'chat.completion.chunk',
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`)
      }

      const meta: GatewayCompleteMeta = {
        activity: body.stream
          ? progress => {
            if (progress.delta && request.chatOnly) {
              sendRole()
              sentChars += progress.delta.length
              writeChunk({ content: progress.delta })
            } else if (progress.content === true) {
              // 信封模型：有真实内容了，先发 role 让客户端脱离"等待"。
              sendRole()
            }
          }
          : undefined,
      }

      try {
        if (body.stream) openStream('validating model response before emission')
        const result = await options.complete(request, controller.signal, meta)
        if (controller.signal.aborted) return
        result.model = body.model

        if (body.stream) {
          // 与提前发出的头保持同一 id/created。
          Object.assign(result, streamStart)
          sendSSE(res, result, {
            includeUsage: body.stream_options?.include_usage,
            roleSent,
            // 仅对话模型：实时增量已直发过，只补发剩余后缀。
            skipContentChars: request.chatOnly ? sentChars : 0,
          })
        } else {
          writeJson(res, 200, result)
        }
      } catch (error) {
        if (controller.signal.aborted) return
        const cause = error as any
        const message = cause?.name === 'TimeoutError' ? '模型请求超时' : cause?.message ?? String(error)
        options.logger?.warn?.(`dsh-opencode-sdk-bridge: 请求失败: ${cause?.code ?? cause?.name ?? 'error'}: ${message}`)
        const payload = { message, type: cause?.code || 'upstream_error', code: cause?.code || 'upstream_error' }
        if (res.headersSent) res.end(`data: ${JSON.stringify({ error: payload })}\n\n`)
        else writeJson(res, cause?.status || 502, { error: payload })
      } finally {
        if (heartbeat) clearInterval(heartbeat)
      }
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      // 完整信封校验前抛出的 BridgeError 是客户端问题（模型 id 不对、载荷不
      // 合法），按 4xx 原样上报；其余是真实故障。
      if (error instanceof BridgeError) {
        writeJson(res, error.status || 400, errorBody(error.message, 'invalid_request_error', error.code))
        return
      }
      options.logger?.error?.(`dsh-opencode-sdk-bridge: 网关内部错误：${(error as Error)?.message ?? error}`)
      writeJson(res, (error as any)?.status || 500, errorBody(`内部错误：${(error as Error)?.message ?? error}`, 'internal_error'))
    }
  })

  // 长推理回合不允许被 socket 层超时掐断。
  server.requestTimeout = 0
  server.headersTimeout = 30_000
  server.keepAliveTimeout = 72_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve()
    })
  })

  return {
    server,
    baseUrl: () => origin!,
    token: () => key,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
