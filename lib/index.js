/**
 * Host 侧插件入口。
 *
 * 启动一个托管、隔离的 OpenCode 运行时（child_process 拉起 + stdout 端口嗅探
 * + 官方 @opencode-ai/sdk 通道），把它暴露成回环 OpenAI 兼容端点，并注册成
 * Harness 的 `opencode-sdk-bridge` 模型 provider。DSH 退出或插件停用时优雅
 * 终止子进程。
 *
 * 启动刻意异步：准备运行时可能需要一次二进制解析（首次甚至是一次下载量级的
 * IO），阻塞 apply() 会拖住整个宿主引导。provider 在运行时健康后注册；在那
 * 之前选择器不出现这个 provider，外部工具也连不上网关。
 *
 * @module dsh-opencode-sdk-bridge
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { runTurn } from './backend.js';
import { createGateway } from './gateway.js';
import { Catalog } from './models.js';
import { dataDirectory } from './platform.js';
import { startRuntime } from './process.js';
import { completion } from './protocol.js';
import { listProviders } from './sdk.js';
import { registerBridgeStatusRoute } from './web-status.js';
/** 稳定的 Cordis 插件名（cordis.patch.yml 里的 id）。 */
export const name = 'llm-opencode-sdk-bridge';
/** 模型注册表必须先存在，provider 才能注册。 */
export const inject = ['llm'];
/**
 * 插件配置 schema：宿主据此校验与展示字段，坏值在配置期就会报出来。
 */
export const Config = z.object({
    dataDir: z.string().description('存放托管 OpenCode 运行时、日志与网关信息的目录（默认在 DSH home 下）'),
    binaryPath: z.string().description('直接使用某个 OpenCode 可执行文件（默认自动解析：xdbridge runtime > ~/.opencode/bin > PATH）'),
    port: z.number().default(0).description('opencode serve 的固定端口；默认 0 = 随机分配，经 stdout 嗅探获得真实端口'),
    gatewayPort: z.number().default(0).description('本地 OpenAI 兼容网关 (/v1) 的固定端口；默认 0 = 随机'),
    extraModels: z.array(z.string()).default([]).description('在硬编码免费名单之外追加的 OpenCode 模型 id'),
});
const DEFAULTS = { port: 0, gatewayPort: 0 };
/** 启动稳定后再做一次目录刷新的延迟。 */
const REFRESH_DELAY_MS = 15_000;
/** 运行时日志文件的上限，超过即轮转。 */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
async function openLogStream(dataDir) {
    const file = path.join(dataDir, 'opencode.log');
    try {
        const stat = await fsp.stat(file);
        if (stat.size > LOG_ROTATE_BYTES)
            await fsp.rename(file, `${file}.previous`);
    }
    catch { /* 没有旧日志 */ }
    return fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
}
/**
 * Cordis 插件入口。
 *
 * @param ctx Cordis 上下文
 * @param config 插件配置
 */
export function apply(ctx, config = {}) {
    const logger = (ctx.logger ?? console);
    const settings = { ...DEFAULTS, ...config };
    const dataDir = dataDirectory({ dataDir: settings.dataDir });
    const catalog = new Catalog(settings.extraModels);
    let runtime;
    let gateway;
    let logStream;
    let closed = false;
    let phase = 'starting';
    let phaseMessage = '';
    let starting;
    /** 设置页轮询的状态文档。 */
    const status = () => {
        const all = catalog.all();
        return {
            phase,
            message: phaseMessage,
            runtimeVersion: runtime?.version,
            endpoint: gateway?.baseUrl(),
            dataDir,
            models: all.map(model => ({
                id: model.id,
                name: model.name,
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxOutputTokens,
                supportsImages: model.images,
                supportsTools: model.toolcall,
                supportsReasoning: model.reasoning,
                supportedEfforts: Object.keys(Object.entries(model.variants ?? {})
                    .filter(([, options]) => !options.disabled && typeof options.reasoningEffort === 'string')
                    .reduce((acc, [variant, options]) => {
                    acc[options.reasoningEffort] = variant;
                    return acc;
                }, {})),
                blocked: model.blocked,
            })),
            metrics: {
                discovered: all.length,
                available: catalog.visible().length,
                blocked: all.length - catalog.visible().length,
            },
        };
    };
    /** 网关直连信息（与 gateway.json 同源）。 */
    const gatewayInfo = () => gateway === undefined ? undefined : {
        baseUrl: `${gateway.baseUrl()}/v1`,
        apiKey: gateway.token(),
        models: catalog.visible().map(model => model.id),
        updatedAt: new Date().toISOString(),
    };
    /** 一次性释放本插件拥有的所有资源。 */
    const shutdown = async () => {
        if (closed)
            return;
        closed = true;
        await gateway?.close().catch(() => { });
        await runtime?.stop().catch(() => { });
        logStream?.end();
    };
    // 在任何资源创建之前注册清理：半途失败也能释放已建立的部分。
    ctx.effect(() => shutdown);
    /** 用运行时实时读数富化目录；失败保留现有列表。 */
    const refresh = async () => {
        if (runtime === undefined)
            throw new Error('运行时尚未就绪');
        const providers = await listProviders(runtime.client).catch(() => undefined);
        catalog.enrich(providers);
        return { enriched: providers !== undefined, visible: catalog.visible().length };
    };
    /** 拦截 DSH / 外部客户端请求并经官方 SDK 转发的一个推理回合。 */
    const complete = async (request, signal, meta) => {
        if (runtime === undefined) {
            const error = new Error('OpenCode 运行时尚未就绪，请稍候重试');
            Object.assign(error, { status: 503, code: 'not_ready' });
            throw error;
        }
        const outcome = await runTurn({ client: runtime.client, hub: runtime.hub, activity: meta.activity }, request, signal);
        return completion(request.model.id, outcome.message, outcome.tokens);
    };
    /** 把网关地址与密钥落盘，供外部工具读取（本机文件，0600）。 */
    const persistGatewayInfo = () => {
        if (gateway === undefined)
            return;
        try {
            const file = path.join(dataDir, 'gateway.json');
            fs.writeFileSync(file, JSON.stringify({
                baseUrl: gateway.baseUrl(),
                apiKey: gateway.token(),
                models: catalog.visible().map(model => model.id),
                updatedAt: new Date().toISOString(),
            }, null, 2), { mode: 0o600 });
        }
        catch (error) {
            logger.warn?.(`dsh-opencode-sdk-bridge: 写入 gateway.json 失败：${error.message}`);
        }
    };
    /** 启动（或重启）运行时与网关。 */
    const init = async () => {
        if (closed)
            return { visible: 0 };
        await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
        if (logStream === undefined)
            logStream = await openLogStream(dataDir);
        if (closed)
            return { visible: 0 };
        // 1. 拉起真实 OpenCode 进程：child_process 静默启动 + stdout 端口嗅探 +
        //    SDK 健康检查。
        runtime = await startRuntime({
            dataDir,
            binaryPath: settings.binaryPath,
            port: settings.port,
            logStream,
            log: line => logger.info?.(`dsh-opencode-sdk-bridge: ${line}`),
        });
        if (closed) {
            await runtime.stop().catch(() => { });
            runtime = undefined;
            return { visible: 0 };
        }
        logger.info?.(`dsh-opencode-sdk-bridge: OpenCode ${runtime.version} 运行时已就绪（${runtime.url}）`);
        // 2. 实时富化硬编码目录（零成本校验在这里发生）。
        await refresh().catch(error => {
            logger.warn?.(`dsh-opencode-sdk-bridge: 模型目录富化失败（稍后自动重试）：${error.message}`);
        });
        if (closed)
            return { visible: 0 };
        // 3. 回环 OpenAI 兼容端点：DSH（pi-ai）与外部工具都从这里进。
        gateway = await createGateway({
            complete,
            getModels: () => catalog.visible(),
            refresh: async () => refresh(),
            port: settings.gatewayPort,
            logger,
        });
        if (closed) {
            await gateway.close().catch(() => { });
            gateway = undefined;
            return { visible: 0 };
        }
        persistGatewayInfo();
        logger.info?.(`dsh-opencode-sdk-bridge: 本地 OpenAI 兼容端点 ${gateway.baseUrl()}/v1（直连凭据见 ${path.join(dataDir, 'gateway.json')}）`);
        // 4. 启动稳定后再做一次目录刷新：第一次读数可能与上游目录传播竞争。
        const timer = setTimeout(() => {
            void refresh().then(() => persistGatewayInfo()).catch(() => { });
        }, REFRESH_DELAY_MS);
        timer.unref?.();
        return { visible: catalog.visible().length };
    };
    /** 运行时健康后注册原生 provider；peer 缺失时网关仍然可用。 */
    const register = async () => {
        if (closed || gateway === undefined)
            return;
        try {
            const { registerBridgeProvider } = await import('./adapter.js');
            const release = registerBridgeProvider(ctx, { gateway, catalog, logger });
            ctx.effect(() => release);
        }
        catch (error) {
            logger.warn?.(`dsh-opencode-sdk-bridge: 原生 provider 注册失败（可在 DSH 里手动添加自定义 OpenAI provider 指向网关）：${error?.message ?? error}`);
        }
    };
    /**
     * 重启托管运行时：设置页 "重启运行时" 按钮的后端。
     *
     * provider 注册与宿主生命周期绑定（ctx.effect），不能在运行中撕掉重建；
     * 所以重启只重建运行时 + 网关，provider 通过 buildModels 每次解析时重读
     * 网关 baseUrl，重启后自动指向新端口。
     */
    const restart = async () => {
        if (closed)
            throw new Error('插件已停用');
        await gateway?.close().catch(() => { });
        gateway = undefined;
        await runtime?.stop().catch(() => { });
        runtime = undefined;
        phase = 'starting';
        phaseMessage = '';
        const result = await init();
        phase = 'ready';
        return result;
    };
    // 设置页的同源状态路由。`webServer` 是可选服务：无头 profile 不挂路由，
    // provider 照常服务模型。
    ctx.inject(['webServer'], webCtx => {
        registerBridgeStatusRoute(webCtx, {
            status,
            refresh: async () => refresh(),
            restart,
            gateway: gatewayInfo,
        });
    });
    // 刻意不 await：准备运行时绝不能拖住宿主引导。
    starting = (async () => {
        try {
            await init();
            await register();
            phase = 'ready';
            logger.info?.(`dsh-opencode-sdk-bridge: 就绪，${catalog.visible().length} 个免费模型可用`);
        }
        catch (error) {
            phase = 'error';
            phaseMessage = error?.message ?? String(error);
            logger.error?.(`dsh-opencode-sdk-bridge: 启动失败：${phaseMessage}`);
            await shutdown().catch(() => { });
            phase = 'stopped';
        }
    })();
}
