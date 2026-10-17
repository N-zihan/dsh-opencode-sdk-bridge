/**
 * 模型目录：以硬编码的免费模型名单为准，用运行时 `/provider` 的实时数据富化。
 *
 * 实时富化只做两件事：补全上下文窗口/输出上限等元数据，以及执行"零成本"校验
 * ——上游一旦把某个模型标为非零价格，就把该模型从列表里下架，这个插件才不可
 * 能悄悄花掉用户的额度。
 *
 * @module dsh-opencode-sdk-bridge/models
 */

import type { ProviderList } from './sdk.js'

/** 运行时把免费模型挂在 opencode 这个 provider 下。 */
export const RUNTIME_PROVIDER = 'opencode'

/** 硬编码的免费模型名单（本插件的基准目录）。 */
export interface HardcodedModel {
  id: string
  name: string
}

export const HARDCODED_FREE_MODELS: readonly HardcodedModel[] = [
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free' },
  { id: 'big-pickle', name: 'Big Pickle' },
  { id: 'glm-5.3-flash-free', name: 'GLM 5.3 Flash Free' },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo v2.6 Flash Free' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free' },
]

/** 目录中的一个模型。`id` 是 wire 形式（`opencode/<rawID>`），`blocked` 为空时可选。 */
export interface CatalogModel {
  id: string
  rawID: string
  name: string
  displayName: string
  contextWindow: number
  maxOutputTokens: number
  images: boolean
  toolcall: boolean
  reasoning: boolean
  variants: Record<string, { reasoningEffort?: string; disabled?: boolean }>
  blocked: null | string
}

/** 模型选择器里显示的名字。 */
export function clientModelID(model: CatalogModel): string {
  return `OC·SDK ${model.name}`
}

/** 客户端回传的模型 id 可能是 wire id、裸 id、名称或显示名，都算命中。 */
export function matchesModelId(model: CatalogModel, requested: string): boolean {
  return requested === model.id
    || requested === model.rawID
    || requested === model.name
    || requested === clientModelID(model)
}

const BASE_DEFAULTS = { contextWindow: 128_000, maxOutputTokens: 32_000 }

function toModel({ id, name }: HardcodedModel): CatalogModel {
  return {
    id: `${RUNTIME_PROVIDER}/${id}`,
    rawID: id,
    name,
    displayName: name,
    contextWindow: BASE_DEFAULTS.contextWindow,
    maxOutputTokens: BASE_DEFAULTS.maxOutputTokens,
    images: false,
    toolcall: true,
    reasoning: false,
    variants: {},
    blocked: null,
  }
}

/** OpenAI reasoning_effort 档位，从弱到强。 */
export const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * 把 OpenAI 的档位名映射到该模型真实存在的 OpenCode variant 上。
 * 运行时没提供的档位不会出现，所以选择器永远不会送出一个会被拒的档位。
 */
export function reasoningEfforts(model: CatalogModel): Record<string, string> {
  if (!model.reasoning) return {}
  return Object.fromEntries(
    Object.entries(model.variants ?? {})
      .filter(([, options]) => !options.disabled && typeof options.reasoningEffort === 'string')
      .filter(([, options]) => (REASONING_LEVELS as readonly string[]).includes(options.reasoningEffort!))
      .map(([variant, options]) => [options.reasoningEffort!, variant]),
  )
}

export class Catalog {
  #models: CatalogModel[] = []

  constructor(extraModels: readonly string[] = []) {
    this.reset(extraModels)
  }

  /** 重建基准目录：硬编码名单 + 配置追加的模型 id。 */
  reset(extraModels: readonly string[] = []): void {
    this.#models = [
      ...HARDCODED_FREE_MODELS.map(toModel),
      ...extraModels.map(id => toModel({ id, name: id })),
    ]
  }

  /**
   * 用运行时 `/provider` 的实时读数富化目录。
   *
   * 富化失败或者某个模型不在运行时名单里，都不会把它撤下——一次读不到说明
   * 不了什么；只有确定性的"不再免费 / 已废弃"才是下架理由。
   */
  enrich(providers: ProviderList | undefined): void {
    if (!providers) return
    const provider = providers.all.find(entry => entry.id === RUNTIME_PROVIDER)
    if (!provider) return

    for (const model of this.#models) {
      const live = provider.models[model.rawID]
      if (!live) continue

      if (typeof live.limit?.context === 'number') model.contextWindow = live.limit.context
      else if (typeof live.limit?.input === 'number') model.contextWindow = live.limit.input
      if (typeof live.limit?.output === 'number') model.maxOutputTokens = live.limit.output

      model.images = live.attachment === true
      model.toolcall = live.tool_call !== false
      model.reasoning = live.reasoning === true
      model.variants = live.variants ?? {}

      if (live.status === 'deprecated') {
        model.blocked = '上游已将该模型标记为废弃'
        continue
      }
      // 零成本校验：任何一个维度有价格，就不再是免费模型。
      const cost = live.cost
      if (cost && (cost.input > 0 || cost.output > 0
        || (cost.cache_read ?? 0) > 0 || (cost.cache_write ?? 0) > 0)) {
        model.blocked = '上游已不再将该模型标为免费'
      }
    }
  }

  /** 当前可选的模型（未被阻塞的），选择器顺序。 */
  visible(): CatalogModel[] {
    return this.#models.filter(model => model.blocked === null)
  }

  /** 全量模型，含被下架的（供诊断）。 */
  all(): CatalogModel[] {
    return [...this.#models]
  }

  /** 按客户端可能发送的任意 id 形式查找。 */
  find(requested: string | undefined): CatalogModel | undefined {
    if (typeof requested !== 'string') return undefined
    const matches = this.#models.filter(model => matchesModelId(model, requested))
    return matches.length === 1 ? matches[0] : undefined
  }
}
