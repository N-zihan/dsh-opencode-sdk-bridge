/**
 * 后端：针对隔离 OpenCode 运行时的一次推理回合。
 *
 * 职责：
 *  - 开一个绑定到 ask 策略 agent 的运行时会话，
 *  - 发送外部会话并要求 JSON 信封，
 *  - 拦截每一个原生权限请求并**拒绝**（免费层放行的前提是 ask 策略，但任何
 *    本地动作都绝不真正执行），
 *  - 校验信封之后才允许它变成一个可执行的动作，
 *  - 畸形信封给一次有界纠正机会，
 *  - 上游错误统一规范化为可读说明（FreeTierError / 5xx / 限流 / 连接中断），
 *    瞬时故障再做一次带退避的自动重试。
 *
 * 相比 dsh-opencode-xdbridge 的取舍：模型偷用原生工具时这里直接拒绝而不是把
 * 动作"移交"外部客户端映射执行——更简单、更保守；信封路径已经是主路径。
 *
 * @module dsh-opencode-sdk-bridge/backend
 */
import { setTimeout as delay } from 'node:timers/promises';
import { BRIDGE_AGENT, CHAT_AGENT, sessionPermissionRules } from './process.js';
import { RUNTIME_PROVIDER } from './models.js';
import { BridgeError, decode, normalizeUpstreamError } from './protocol.js';
import { abortSession, createSession, deleteSession, promptSession, rejectPermission, } from './sdk.js';
/** 同一轮里原生动作被拒绝次数的上限：超过说明模型不肯走信封，中止本回合。 */
const NATIVE_REJECTION_LIMIT = 3;
/**
 * 瞬时上游故障（5xx / 限流 / 连接中断）的自动重试上限与退避间隔。
 * 只重试一次：DSH 侧自身还有重试，这里叠两层即可，避免请求量翻倍。
 */
const MAX_UPSTREAM_RETRIES = 1;
const UPSTREAM_RETRY_DELAY_MS = 1800;
const isToolPart = (part) => part.type === 'tool';
const isTextPart = (part) => part.type === 'text';
/** calls 字段的 JSON Schema：外部工具清单是唯一合法的取值域。 */
function buildCallsSchema(request) {
    const tools = request.choice === 'none'
        ? []
        : request.forced
            ? request.tools.filter(tool => tool.function.name === request.forced)
            : request.tools;
    return {
        type: 'array',
        ...(request.parallel ? {} : { maxItems: 1 }),
        ...(request.choice === 'required' || request.forced ? { minItems: 1 } : {}),
        ...(tools.length
            ? {
                items: {
                    anyOf: tools.map(({ function: tool }) => ({
                        type: 'object',
                        properties: {
                            name: { type: 'string', const: tool.name },
                            arguments: tool.parameters || { type: 'object' },
                        },
                        required: ['name', 'arguments'],
                        additionalProperties: false,
                    })),
                },
            }
            : { maxItems: 0, items: { type: 'object' } }),
    };
}
/** 一次纠正提示（只在已经失败过的路径上出现）。 */
function correctionPrompt(truncated) {
    return truncated
        ? 'Your previous response was cut off by the output limit before the envelope was complete. Send it again in a much more compact form: content holds the conclusion, calls hold only the essential arguments, and keep reasoning to a minimum.'
        : 'Your previous response failed the adapter JSON format check. No external tool has been executed from that response. Return the intended answer or external tool proposal using StructuredOutput with exactly {"content":"a string, empty if only calling tools","calls":[{"name":"an allowed external tool name","arguments":{}}]}. Both fields are required; use [] when no tools are needed. Do not invoke native tools, repeat external searches, or claim actions have completed. Preserve the external conversation and its existing tool results.';
}
export async function runTurn(context, request, signal) {
    const { client, hub } = context;
    // 任一尝试成功即整体成功；一旦有内容流给用户就不再重试（避免重复输出）。
    let successful = false;
    let streamForwarded = false;
    /** 单次完整尝试：全新会话 + 全新监听器，内部含一次信封纠正重试。 */
    const attemptOnce = async () => {
        const session = await createSession(client, {
            title: 'DSH OpenCode SDK Bridge',
            permission: sessionPermissionRules(),
        });
        let nativeRejections = 0;
        let overwhelmed = false;
        let lastStreamText = '';
        const repliedPermissions = new Set();
        const rejectedCalls = new Set();
        // 一个监听器服务本回合的所有事件：权限请求一律拒绝；
        // 仅对话模型的文本增量发给网关做实时流。
        const listener = (event) => {
            const properties = event.properties ?? {};
            if (event.type === 'permission.asked' || event.type === 'permission.updated') {
                if (properties.sessionID !== session.id || !properties.id)
                    return;
                if (repliedPermissions.has(properties.id))
                    return;
                repliedPermissions.add(properties.id);
                if (properties.callID)
                    rejectedCalls.add(properties.callID);
                nativeRejections += 1;
                context.activity?.({ type: 'permission', status: 'permission' });
                if (nativeRejections >= NATIVE_REJECTION_LIMIT) {
                    // 模型反复偷用本地工具：中止会话，让在途请求尽快结束。
                    overwhelmed = true;
                    void abortSession(client, session.id);
                    return;
                }
                void rejectPermission(client, session.id, properties.id).catch(() => { });
                return;
            }
            if (event.type === 'message.part.updated') {
                const part = properties.part;
                if (!part?.sessionID || part.sessionID !== session.id)
                    return;
                if (part.type === 'reasoning' && part.text) {
                    context.activity?.({ type: 'progress', content: true, status: 'reasoning' });
                    return;
                }
                if (part.type === 'text' && typeof part.text === 'string') {
                    if (!request.chatOnly) {
                        // 信封模型：文本不是最终内容，只给"有内容"信号（网关用来提前发 role）。
                        context.activity?.({ type: 'progress', content: true, status: 'receiving' });
                        return;
                    }
                    let delta = typeof properties.delta === 'string' ? properties.delta : undefined;
                    if (delta === undefined && part.text.length >= lastStreamText.length && part.text.startsWith(lastStreamText)) {
                        delta = part.text.slice(lastStreamText.length);
                    }
                    lastStreamText = part.text;
                    if (delta) {
                        // 对话模型：增量已直发给用户，此后不能整体重试（会重复文本）。
                        streamForwarded = true;
                        context.activity?.({ type: 'stream', content: true, delta });
                    }
                }
                return;
            }
            if (event.type === 'session.error' && properties.sessionID === session.id) {
                // 活动面板里的错误也一并规范化，用户看到的是人话而不是原始透传串。
                const rawError = properties.error;
                context.activity?.({
                    type: 'error',
                    status: 'error',
                    message: normalizeUpstreamError(rawError?.data?.message || rawError?.message || rawError?.name || '上游错误').message,
                });
            }
        };
        const unsubscribe = hub.subscribe(listener);
        const payload = {
            model: { providerID: RUNTIME_PROVIDER, modelID: request.model.rawID },
            ...(request.variant ? { variant: request.variant } : {}),
            agent: request.chatOnly ? CHAT_AGENT : BRIDGE_AGENT,
            system: request.chatOnly
                ? request.system
                : `${request.system}\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.`,
            ...(request.chatOnly
                ? {}
                : {
                    format: {
                        type: 'json_schema',
                        retryCount: 0,
                        schema: {
                            type: 'object',
                            properties: { content: { type: 'string' }, calls: buildCallsSchema(request) },
                            required: ['content', 'calls'],
                            additionalProperties: false,
                        },
                    },
                }),
            parts: [{ type: 'text', text: request.text }, ...request.images],
        };
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                if (signal?.aborted)
                    throw new BridgeError('请求已取消', 499, 'aborted');
                const response = await promptSession(client, session.id, payload, signal);
                if (overwhelmed) {
                    throw new BridgeError(`模型反复尝试调用本地工具（已拒绝 ${nativeRejections} 次），中止本轮`, 502, 'native_tool_activity');
                }
                // 意外的本地工具活动：除了信封载体 StructuredOutput 和参数解析失败标记，
                // 不该有任何原生工具；我们拒绝过的调用会以 error 状态回来，不算数。
                const foreign = response.parts
                    .filter(isToolPart)
                    .filter(part => part.tool !== 'StructuredOutput'
                    && part.tool !== 'invalid'
                    && !(rejectedCalls.has(part.callID) && part.state.status === 'error'));
                if (foreign.length > 0) {
                    throw new BridgeError('检测到意外的本地工具活动，已拒绝该响应', 502, 'native_tool_activity');
                }
                const info = response.info;
                // wire 上还存在生成类型没收录的 StructuredOutputError：先放宽再比较。
                if (info.error && (request.chatOnly || info.error.name !== 'StructuredOutputError')) {
                    const error = info.error;
                    const rawStatus = typeof error?.data?.statusCode === 'number' ? error.data.statusCode : undefined;
                    // 不再透传上游原始错误（例如裸 500 / FreeTierError）：先归类给可读说明。
                    throw normalizeUpstreamError(error?.data?.message || error?.message || error?.name || '模型请求失败', rawStatus);
                }
                // 信封的三种到达方式：runtime 的 structured 字段、已完成的
                // StructuredOutput 调用、纯文本。
                const structuredPart = response.parts.find((part) => {
                    return part.type === 'tool' && part.tool === 'StructuredOutput'
                        && part.state?.status === 'completed' && !!part.state?.input;
                });
                const text = info.structured !== undefined
                    ? JSON.stringify(info.structured)
                    : response.parts.filter(isTextPart).map(part => part.text).join('');
                try {
                    if (info.finish === 'length') {
                        throw new BridgeError('模型输出被截断', 502, 'output_truncated');
                    }
                    if (!text.trim()) {
                        const unparsed = response.parts.find((part) => part.type === 'tool' && part.tool === 'invalid');
                        const detail = unparsed
                            ? `模型提交的调用参数不是合法 JSON：${String(unparsed.state.input?.error ?? '运行时未给出细节')}`
                            : '模型没有返回信封：structured、已完成的 StructuredOutput 调用、文本三者都为空';
                        throw new BridgeError(detail, 502, 'invalid_model_output');
                    }
                    const message = request.chatOnly
                        ? { role: 'assistant', content: text }
                        : decode(text, request);
                    successful = true;
                    return { message, tokens: info.tokens };
                }
                catch (error) {
                    // 一次有界纠正，只发生在已经失败的路径上。
                    if (request.chatOnly || signal?.aborted
                        || !(error instanceof BridgeError)
                        || !['invalid_model_output', 'invalid_tool_call', 'output_truncated'].includes(error.code)
                        || attempt === 1) {
                        throw error;
                    }
                    payload.parts = [{ type: 'text', text: correctionPrompt(error.code === 'output_truncated') }];
                }
            }
            throw new BridgeError('模型未能返回有效输出', 502, 'invalid_model_output');
        }
        finally {
            unsubscribe();
            // 取消必须停掉后端的工作，而不只是断开 HTTP 连接。
            if (!successful)
                await abortSession(client, session.id);
            await deleteSession(client, session.id);
        }
    };
    // 瞬时上游故障（5xx / 限流 / 连接中断）带退避自动重试一次：每次尝试用全新
    // 会话，尚未给用户流出任何内容时才安全（对话模型一旦直发过增量就不再重试）。
    for (let retryNo = 0;; retryNo++) {
        try {
            return await attemptOnce();
        }
        catch (error) {
            if (error instanceof BridgeError) {
                // 可重试的瞬时故障且尚有余地：退避后换全新会话重试。
                if (error.retryable && retryNo < MAX_UPSTREAM_RETRIES && !streamForwarded && !signal?.aborted) {
                    await delay(UPSTREAM_RETRY_DELAY_MS, undefined, { signal }).catch(() => { });
                    if (signal?.aborted)
                        throw new BridgeError('请求已取消', 499, 'aborted');
                    continue;
                }
                throw error;
            }
            // SDK 层抛出的传输错误不是 BridgeError，先尝试归类。
            const normalized = normalizeUpstreamError(error?.message || String(error));
            if (normalized.code === 'upstream_error')
                throw error;
            if (normalized.retryable && retryNo < MAX_UPSTREAM_RETRIES && !streamForwarded && !signal?.aborted) {
                await delay(UPSTREAM_RETRY_DELAY_MS, undefined, { signal }).catch(() => { });
                if (signal?.aborted)
                    throw new BridgeError('请求已取消', 499, 'aborted');
                continue;
            }
            throw normalized;
        }
    }
}
