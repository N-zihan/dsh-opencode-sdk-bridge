/**
 * 独立 typecheck 用的 peer 依赖最小类型桩。
 *
 * 这些包在 DSH profile 内安装后由真实声明接管；本文件只让 `npm run
 * typecheck` 可以在插件目录里脱离 profile 单独运行（只验证本插件自身的
 * 语法与内部类型一致性）。不要在运行时代码里 import 本目录。
 *
 * 仅由 tsconfig.typecheck.json 引入；正常构建（tsconfig.json）不包含它。
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    logger?: {
      info?: (text: string) => void
      warn?: (text: string) => void
      error?: (text: string) => void
    }
    effect(body: () => unknown): void
    get<T = any>(name: string): T | undefined
    inject(deps: readonly string[], body: (ctx: Context) => void): void
  }
}

declare module '@deepseek-ai/schemastery' {
  const z: any
  export default z
}

declare module '@deepseek-ai/dsh-llm' {
  export function resolveRetryPolicy(...args: any[]): any
  export function resolveImageAttachmentAccess(...args: any[]): any
}

declare module '@deepseek-ai/dsh-llm-pi-ai' {
  export class PiAiAdapter {
    constructor(options: any)
  }
}

declare module '@earendil-works/pi-ai' {
  export function createProvider(options: any): any
}

declare module '@earendil-works/pi-ai/api/openai-completions.lazy' {
  export function openAICompletionsApi(): any
}
