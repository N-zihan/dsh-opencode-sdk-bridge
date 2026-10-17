/**
 * `opencode-sdk-bridge` 的 pi-ai provider：把回环网关注册进 Harness 的 LLM
 * seam（ctx.llm）。
 *
 * 组装方式（createProvider + openAICompletionsApi + 惰性凭据面 + 网关的进程内
 * 密钥作为 apiKey）与其他回环型 Harness provider 在本宿主上验证过的模式一致。
 * 类型在 pi-ai 的组合边界上做受控放宽（`as any`）——运行时形状来自已被验证的
 * 实现。
 *
 * @module dsh-opencode-sdk-bridge/adapter
 */
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { clientModelID, reasoningEfforts } from './models.js';
/** 本插件拥有的 provider 路由。 */
export const PROVIDER = 'opencode-sdk-bridge';
/** 模型选择器里显示的名字。 */
export const DISPLAY_NAME = 'OpenCode SDK 免费模型';
/** 设置命名空间。 */
export const SETTINGS_NS = 'opencode-sdk-bridge';
/** 单次流读取挂起时的空闲上限。 */
export const STREAM_IDLE_TIMEOUT_MS = 300_000;
/** dsh-llm-pi-ai 默认的请求图片预算。 */
const REQUEST_IMAGE_BUDGETS = {
    maxRequestImageBytes: 20_971_520,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
};
/**
 * 惰性 pi-ai 凭据面：这条路由只认网关的进程内密钥，pi-ai 自己的凭据生命周期
 * 绝不能为它制造凭据。
 */
const INERT_AUTH = {
    credentials: {
        async read() { return undefined; },
        async list() { return []; },
        async modify() {
            throw new Error('dsh-opencode-sdk-bridge: this route has no pi-ai credential lifecycle');
        },
        async delete() { },
    },
    authContext: {
        async env() { return undefined; },
        async fileExists() { return false; },
    },
};
/** 这些模型免费，按定义每 token 价格为零。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function modelInput(info) {
    return info.images ? ['text', 'image'] : ['text'];
}
/**
 * 只映射该模型真实暴露的推理档位；未声明的档位映射到 null（关闭），选择器就
 * 不会给出一个会被运行时 400 的档位。
 */
function thinkingLevelMap(info) {
    const efforts = reasoningEfforts(info);
    if (Object.keys(efforts).length === 0)
        return undefined;
    const map = {};
    for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
        map[level] = Object.hasOwn(efforts, level) ? efforts[level] : null;
    }
    map.off = null;
    return map;
}
/** 构建一个指向回环网关的 pi-ai 模型描述。 */
function toPiModel(info, baseUrl) {
    const map = thinkingLevelMap(info);
    return {
        id: info.id,
        name: info.name,
        api: 'openai-completions',
        provider: PROVIDER,
        baseUrl,
        input: modelInput(info),
        cost: NO_COST,
        contextWindow: info.contextWindow,
        maxTokens: info.maxOutputTokens,
        reasoning: map !== undefined,
        ...(map === undefined ? {} : { thinkingLevelMap: map }),
        compat: { supportsReasoningEffort: map !== undefined },
    };
}
/**
 * 组装 adapter 并注册进 LLM seam。返回释放函数。
 *
 * `buildModels` 每次重新读取实时目录，且每个模型的 baseUrl 在读取时重新解析，
 * 这样网关的随机端口从启动后的第一个快照起就生效。
 */
export function registerBridgeProvider(ctx, options) {
    const { gateway, catalog } = options;
    const buildModels = () => {
        const baseUrl = `${gateway.baseUrl()}/v1`;
        return catalog.visible().map(info => toPiModel(info, baseUrl));
    };
    const base = createProvider({
        id: PROVIDER,
        name: DISPLAY_NAME,
        auth: {
            apiKey: {
                name: 'OpenCode SDK Bridge loopback secret',
                async resolve(input) {
                    const apiKey = input?.credential?.key;
                    return apiKey === undefined || apiKey.length === 0
                        ? undefined
                        : { auth: { apiKey }, source: 'OpenCode SDK Bridge' };
                },
            },
        },
        models: buildModels(),
        api: openAICompletionsApi(),
    });
    const provider = { ...base, getModels: () => buildModels() };
    const profile = {
        provider: PROVIDER,
        displayName: DISPLAY_NAME,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(undefined, 'dsh-opencode-sdk-bridge retryPolicy'),
        configuredMaxTokens: new Map(),
        // dsh-llm-pi-ai >= 0.1.5-rc.2 在每次模型解析时读 profile.modelErrors；
        // 目录来自实时运行时，没有预知的失败。
        modelErrors: new Map(),
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider,
    };
    const profiles = new Map([[PROVIDER, profile]]);
    const adapter = new PiAiAdapter({
        profiles: () => profiles,
        auth: INERT_AUTH,
        // 网关的进程内密钥就是 OpenAI apiKey；网关负责校验它。
        resolveApiKey: async () => gateway.token(),
        // 声明了图片输入的路由必须接好两个钩子，否则宿主适配器会拒绝带图片的请求。
        resolveAttachments: () => ctx.get('attachments'),
        resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    });
    // llm 服务由宿主注入（inject: ['llm']），这里只做受控访问。
    const llm = ctx.llm;
    const releaseAdapter = llm.registerAdapter([PROVIDER], adapter);
    const releaseDirectory = llm.registerConfigurableProviders([{
            provider: PROVIDER,
            displayName: DISPLAY_NAME,
            settingsNs: SETTINGS_NS,
            settingsPath: [],
            declared: false,
        }]);
    // 用实时目录应答 discovery，新出现的免费模型不用重启宿主就能进选择器。
    const releaseDiscovery = llm.registerModelDiscovery(SETTINGS_NS, async (request) => {
        if (request?.provider !== undefined && request.provider !== PROVIDER)
            return [];
        return catalog.visible().map(model => ({
            id: model.id,
            name: clientModelID(model),
            contextWindow: model.contextWindow,
            maxTokens: model.maxOutputTokens,
            inputModalities: model.images ? ['text', 'image'] : ['text'],
        }));
    });
    options.logger?.info?.(`dsh-opencode-sdk-bridge: provider "${PROVIDER}" 已注册，${catalog.visible().length} 个模型`);
    return () => {
        try {
            releaseDiscovery();
        }
        catch { /* 已释放 */ }
        try {
            releaseDirectory();
        }
        catch { /* 已释放 */ }
        try {
            releaseAdapter();
        }
        catch { /* 已释放 */ }
    };
}
