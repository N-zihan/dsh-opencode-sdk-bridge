/**
 * @opencode-ai/sdk 客户端的薄封装：Basic 认证、统一的 data/error 解包、事件总
 * 线，以及"生成类型没写、但线上真实接受"的字段的本地类型。
 *
 * 为什么有扩展字段：SDK 的类型由 OpenAPI 生成，个别字段（会话级权限列表、
 * prompt 的 format/variant、assistant 的 structured）落后于真实服务。它们是
 * wire 契约的一部分（dsh-opencode-xdbridge 与本机 opencode 1.19.x 的实测路径
 * 都依赖它们），所以在这里显式声明、并在边界处做一次带注释的收窄转换。
 *
 * @module dsh-opencode-sdk-bridge/sdk
 */
import { setTimeout as delay } from 'node:timers/promises';
import { createOpencodeClient, } from '@opencode-ai/sdk';
import { BridgeError, normalizeUpstreamError } from './protocol.js';
/**
 * 创建一个连到本地 `opencode serve` 的 SDK 客户端。
 *
 * 认证靠启动子进程时注入的 OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD
 * ——这是原生 OpenCode 客户端自己的通行方式。
 */
export function makeClient(url, password) {
    const token = Buffer.from(`opencode:${password}`).toString('base64');
    return createOpencodeClient({
        baseUrl: url,
        headers: { Authorization: `Basic ${token}` },
    });
}
/**
 * SDK 默认 responseStyle='fields'：结果里 data / error 各占一个字段。这里统一
 * 转成异常，让调用方只有一个成功路径。
 */
export function unwrap(result, context) {
    const { data, error } = result;
    if (error !== undefined && error !== null) {
        const message = error?.data?.message ?? error?.message ?? JSON.stringify(error);
        const status = typeof error?.data?.statusCode === 'number' ? error.data.statusCode : undefined;
        const normalized = normalizeUpstreamError(message, status);
        // 已识别的上游故障：归一化说明自含语境，不再重复拼接 context 前缀。
        if (normalized.code !== 'upstream_error')
            throw normalized;
        throw new BridgeError(`${context}：${message}`, normalized.status, 'upstream_error');
    }
    if (data === undefined || data === null)
        throw new BridgeError(`${context}：空响应`, 502, 'upstream_error');
    return data;
}
export async function createSession(client, options = {}) {
    const body = {
        ...(options.title ? { title: options.title } : {}),
        ...(options.permission ? { permission: options.permission } : {}),
    };
    const request = { body };
    return unwrap(await client.session.create(request), '创建会话失败');
}
/** 向会话发送一个 prompt，等待本轮完成并返回 assistant 消息。 */
export async function promptSession(client, sessionID, body, signal) {
    const request = { path: { id: sessionID }, body, ...(signal ? { signal } : {}) };
    return unwrap(await client.session.prompt(request), '模型请求失败');
}
/** 拒绝一个原生权限请求（绝不放行本地动作）。 */
export async function rejectPermission(client, sessionID, permissionID, timeoutMs = 5000) {
    const request = {
        path: { id: sessionID, permissionID },
        body: { response: 'reject' },
        signal: AbortSignal.timeout(timeoutMs),
        ...(timeoutMs === 0 ? { signal: undefined } : {}),
    };
    return unwrap(await client.postSessionIdPermissionsPermissionId(request), '拒绝权限失败');
}
/** 尽力而为地中止会话；失败不影响主流程。 */
export async function abortSession(client, sessionID) {
    try {
        await client.session.abort({ path: { id: sessionID }, signal: AbortSignal.timeout(5000) });
    }
    catch { /* 会话可能已结束 */ }
}
/** 尽力而为地删除会话；失败不影响主流程。 */
export async function deleteSession(client, sessionID) {
    try {
        await client.session.delete({ path: { id: sessionID }, signal: AbortSignal.timeout(5000) });
    }
    catch { /* 会话可能已不存在 */ }
}
/** 读取运行时 `/provider`，用于目录富化与零成本校验。 */
export async function listProviders(client) {
    return unwrap(await client.provider.list(), '读取 provider 失败');
}
// ---------------------------------------------------------------------------
// 事件总线：一条 SSE 连接服务所有在途请求
// ---------------------------------------------------------------------------
/**
 * 把 client.event.subscribe() 变成可注册监听器的总线，断线自动重连。
 * 每个在途请求按 sessionID 过滤自己关心的事件。
 */
export class EventHub {
    #client;
    #listeners = new Set();
    #onError;
    #controller;
    constructor(client, onError) {
        this.#client = client;
        this.#onError = onError;
    }
    start() {
        if (this.#controller)
            return;
        const controller = new AbortController();
        this.#controller = controller;
        void (async () => {
            while (!controller.signal.aborted) {
                try {
                    const events = await this.#client.event.subscribe({ signal: controller.signal });
                    for await (const event of events.stream) {
                        this.#dispatch(event);
                    }
                }
                catch (error) {
                    if (controller.signal.aborted)
                        return;
                    this.#onError?.(error instanceof Error ? error : new Error(String(error)));
                    await delay(1000, undefined, { signal: controller.signal }).catch(() => { });
                }
            }
        })().catch(() => { });
    }
    stop() {
        this.#controller?.abort();
        this.#controller = undefined;
    }
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    #dispatch = (event) => {
        for (const listener of [...this.#listeners]) {
            try {
                listener(event);
            }
            catch { /* 监听器的错误不能拖垮总线 */ }
        }
    };
}
/** 用一次 SDK 调用当健康检查，直到服务真正可用。 */
export async function probeReady(client, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await client.config.get();
            return;
        }
        catch {
            if (Date.now() > deadline) {
                throw new BridgeError('OpenCode 健康检查超时', 502, 'startup_timeout');
            }
            await delay(400);
        }
    }
}
