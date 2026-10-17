/**
 * Browser half: the OpenCode SDK Bridge settings page.
 *
 * Authored as the body of the host's module-loader factory: plain CJS, may
 * `require` only platform-seeded packages (`react`), and ends by assigning
 * `module.exports`. The host wraps this file into lib/client.js at build time.
 *
 * @module dsh-opencode-sdk-bridge/client
 */

const React = require('react')
const h = React.createElement

/** Stable browser-plugin name. */
const name = 'dsh-opencode-sdk-bridge-client'

/** Only services present on every host line may be named here. */
const inject = ['slots', 'locale']

/** Settings namespace, shared with the host half. */
const SETTINGS_NS = 'opencode-sdk-bridge'

/** Plugin-owned routes. Mirrored from lib/web-status.js. */
const STATUS_PATH = '/plugins/dsh-opencode-sdk-bridge/status'
const REFRESH_PATH = '/plugins/dsh-opencode-sdk-bridge/models/refresh'
const RESTART_PATH = '/plugins/dsh-opencode-sdk-bridge/runtime/restart'
const GATEWAY_PATH = '/plugins/dsh-opencode-sdk-bridge/gateway'

/** How often the card re-reads the status document while it is open. */
const POLL_INTERVAL_MS = 5000

/** Locale copy. */
const zh = {
  'row.navLabel': 'OpenCode·SDK',
  'page.title': 'OpenCode SDK Bridge',
  'page.desc': '由本机受管的 OpenCode 运行时（官方 SDK 通道）提供 5 个免费模型。',
  'action.refresh': '读取模型',
  'action.refreshing': '正在读取…',
  'action.restart': '重启运行时',
  'action.restarting': '正在重启…',
  'metric.discovered': '总数',
  'metric.available': '可用',
  'metric.blocked': '已下架',
  'status.starting': '正在启动隔离模型服务',
  'status.ready': '运行中',
  'status.error': '运行时错误',
  'status.stopped': '已停止',
  'status.retry': '重试',
  'models.title': '模型目录',
  'models.hint': '能力徽章来自运行时实时读数；已下架的模型不再出现在选择器里。',
  'models.empty': '正在启动或扫描模型，完成后将在这里显示。',
  'badge.reasoning': '推理',
  'badge.images': '图片',
  'badge.tools': '工具',
  'badge.blocked': '已下架',
  'detail.context': '上下文',
  'detail.output': '输出上限',
  'detail.images': '图片输入',
  'detail.tools': '工具调用',
  'detail.reasoning': '推理',
  'detail.efforts': '可选档位',
  'detail.default': '使用默认模式',
  'detail.yes': '支持',
  'detail.no': '不支持',
  'detail.close': '收起',
  'gateway.title': '外部工具直连',
  'gateway.hint': '任何 OpenAI 兼容客户端都可以用下面的地址与密钥直接调用这些免费模型（仅限本机回环）。',
  'gateway.copy': '复制',
  'gateway.copied': '已复制',
  'gateway.baseUrl': 'Base URL',
  'gateway.apiKey': 'API Key',
  'gateway.models': '可用模型',
  'footer.note': '免费模型由 OpenCode Zen 提供，清单与额度随上游变化。零成本校验会在上游开始收费时自动下架模型。',
  'runtime.version': '运行时',
  'runtime.endpoint': '本地端点',
  'runtime.dataDir': '数据目录',
  'feedback.refreshed': '已读取 {n} 个免费模型。',
  'feedback.restarted': '运行时已重启，共 {n} 个免费模型。',
  'error.prefix': '操作失败：',
}

const en = {
  'row.navLabel': 'OpenCode·SDK',
  'page.title': 'OpenCode SDK Bridge',
  'page.desc': 'Five free models served by a managed local OpenCode runtime over the official SDK channel.',
  'action.refresh': 'Read models',
  'action.refreshing': 'Reading…',
  'action.restart': 'Restart runtime',
  'action.restarting': 'Restarting…',
  'metric.discovered': 'Total',
  'metric.available': 'Available',
  'metric.blocked': 'Delisted',
  'status.starting': 'Starting the isolated model service',
  'status.ready': 'Running',
  'status.error': 'Runtime error',
  'status.stopped': 'Stopped',
  'status.retry': 'Retry',
  'models.title': 'Model directory',
  'models.hint': 'Capability badges come from live runtime readings; delisted models never reach the picker.',
  'models.empty': 'Models appear here once startup and scanning finish.',
  'badge.reasoning': 'Reasoning',
  'badge.images': 'Images',
  'badge.tools': 'Tools',
  'badge.blocked': 'Delisted',
  'detail.context': 'Context',
  'detail.output': 'Output limit',
  'detail.images': 'Image input',
  'detail.tools': 'Tool calls',
  'detail.reasoning': 'Reasoning',
  'detail.efforts': 'Levels',
  'detail.default': 'using the default mode',
  'detail.yes': 'yes',
  'detail.no': 'no',
  'detail.close': 'Collapse',
  'gateway.title': 'Direct access for external tools',
  'gateway.hint': 'Any OpenAI-compatible client can call these free models directly with the endpoint and key below (loopback only).',
  'gateway.copy': 'Copy',
  'gateway.copied': 'Copied',
  'gateway.baseUrl': 'Base URL',
  'gateway.apiKey': 'API Key',
  'gateway.models': 'Models',
  'footer.note': 'Free models come from OpenCode Zen; the roster and quota follow upstream. The zero-cost check delists a model the moment upstream starts charging.',
  'runtime.version': 'Runtime',
  'runtime.endpoint': 'Endpoint',
  'runtime.dataDir': 'Data dir',
  'feedback.refreshed': 'Read {n} free model(s).',
  'feedback.restarted': 'Runtime restarted with {n} free model(s).',
  'error.prefix': 'Failed: ',
}

/** Card styles. Uses the host's own theme tokens so it matches built-in pages. */
const CSS = `
.dsm-ocsb-page{max-width:860px;flex-direction:column;gap:16px;display:flex}
.dsm-ocsb-head{align-items:center;gap:12px;flex-wrap:wrap;display:flex}
.dsm-ocsb-headcopy{flex-direction:column;gap:4px;min-width:0;flex:1 1 220px;display:flex}
.dsm-ocsb-title{color:var(--dsw-alias-label-primary,#e6e6e6);margin:0;font-size:16px;font-weight:600;line-height:1.4}
.dsm-ocsb-desc{color:var(--dsw-alias-label-tertiary,#999);margin:0;font-size:13px;line-height:1.5}
.dsm-ocsb-actions{align-items:center;gap:8px;flex-wrap:wrap;flex:none;display:flex}
.dsm-ocsb-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#232529);border-radius:14px;flex-direction:column;gap:12px;padding:14px 16px;display:flex}
.dsm-ocsb-cardtitle{color:var(--dsw-alias-label-primary,#e6e6e6);margin:0;font-size:14px;font-weight:600;line-height:1.4}
.dsm-ocsb-cardhint{color:var(--dsw-alias-label-tertiary,#9aa0a8);margin:0;font-size:11px;line-height:1.5}
.dsm-ocsb-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-ocsb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-ocsb-btn:disabled{opacity:.4;cursor:default}
.dsm-ocsb-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-ocsb-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-ocsb-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126)}
.dsm-ocsb-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-ocsb-status{align-items:center;gap:10px;flex-wrap:wrap;display:flex;font-size:13px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-ocsb-dot{width:8px;height:8px;flex:none;border-radius:50%;background:#28c8b4}
.dsm-ocsb-dot-error{background:#e85a5a}
.dsm-ocsb-dot-starting{background:#d8a657}
.dsm-ocsb-metrics{display:flex;gap:26px;flex-wrap:wrap}
.dsm-ocsb-metric{flex-direction:column;gap:2px;display:flex}
.dsm-ocsb-metric b{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:20px;font-weight:600;line-height:1.2}
.dsm-ocsb-metric span{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.4}
.dsm-ocsb-meta{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a8);word-break:break-all}
.dsm-ocsb-list{flex-direction:column;gap:6px;display:flex}
.dsm-ocsb-item{flex-direction:column;gap:6px;display:flex}
.dsm-ocsb-row{align-items:flex-start;gap:11px;width:100%;text-align:left;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);display:flex}
.dsm-ocsb-row:hover{border-color:var(--dsw-alias-border-l2)}
.dsm-ocsb-row-selected{border-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-ocsb-row-icon{width:15px;flex:none;text-align:center;color:#28c8b4;font-size:13px;line-height:1.5}
.dsm-ocsb-row-info{flex-direction:column;gap:3px;min-width:0;flex:1 1 auto;display:flex}
.dsm-ocsb-row-name{font-size:13px;font-weight:600;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-ocsb-row-meta{font-size:11px;color:var(--dsw-alias-label-dimmed,#7b828c);line-height:1.4}
.dsm-ocsb-badges{align-items:center;gap:6px;flex:none;flex-wrap:wrap;display:flex;justify-content:flex-end}
.dsm-ocsb-badge{font-size:11px;line-height:1.6;border-radius:6px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);color:var(--dsw-alias-label-secondary,#c6c9d0);background:transparent;white-space:nowrap}
.dsm-ocsb-badge-reasoning{color:#8ab4f8;border-color:rgba(138,180,248,.4)}
.dsm-ocsb-badge-images{color:#7fd1b9;border-color:rgba(127,209,185,.4)}
.dsm-ocsb-badge-bad{color:#ff6b68;border-color:rgba(255,107,104,.4)}
.dsm-ocsb-detail{gap:6px;border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-3,#2a2c33);display:flex;flex-direction:column}
.dsm-ocsb-detail-id{margin:0;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#c6c9d0);word-break:break-all}
.dsm-ocsb-detail p{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-ocsb-detail .dsm-ocsb-error{color:#ff6b68}
.dsm-ocsb-empty{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:13px;margin:0}
.dsm-ocsb-feedback{border-radius:10px;padding:9px 12px;font-size:12px;line-height:1.5;background:rgba(40,200,180,.12);color:var(--dsw-alias-label-secondary,#c6c9d0);border:1px solid rgba(40,200,180,.3)}
.dsm-ocsb-gwrow{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.dsm-ocsb-gwlabel{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-ocsb-gwvalue{flex:1 1 200px;min-width:0;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#c6c9d0);word-break:break-all}
.dsm-ocsb-gwcopy{flex:none}
.dsm-ocsb-footer{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:1.6;margin:0}
.dsm-ocsb-spinner{display:inline-block;width:11px;height:11px;border:2px solid var(--dsw-alias-border-l2,#3a3d45);border-top-color:var(--dsw-alias-label-secondary,#c6c9d0);border-radius:50%;animation:dsm-ocsb-spin .7s linear infinite}
@keyframes dsm-ocsb-spin{to{transform:rotate(360deg)}}
`

/** Install or refresh this card's stylesheet. */
function installStyles() {
  if (typeof document === 'undefined') return
  const id = 'dsh-opencode-sdk-bridge/client.css'
  const existing = document.querySelector(`style[data-plugin-css="${id}"]`)
  if (existing !== null) {
    existing.textContent = CSS
    return
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-opencode-sdk-bridge'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** Substitute `{name}` placeholders. */
function fill(template, params) {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match))
}

/** One small badge. */
function badge(text, variant) {
  return h('span', { className: `dsm-ocsb-badge${variant ? ` dsm-ocsb-badge-${variant}` : ''}`, key: text }, text)
}

/** The model directory; blocked models sorted last. */
function ModelList({ status, t, selected, onSelect }) {
  const models = [...(status.models ?? [])].sort((a, b) =>
    (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || a.name.localeCompare(b.name))
  if (models.length === 0) return h('p', { className: 'dsm-ocsb-empty' }, t('models.empty'))

  const rows = []
  for (const model of models) {
    const badges = []
    if (model.supportsReasoning) badges.push(badge(t('badge.reasoning'), 'reasoning'))
    if (model.supportsImages) badges.push(badge(t('badge.images'), 'images'))
    if (model.supportsTools) badges.push(badge(t('badge.tools')))
    if (model.blocked) badges.push(badge(t('badge.blocked'), 'bad'))

    const open = selected === model.id
    rows.push(h('div', { key: model.id, className: 'dsm-ocsb-item' },
      h('button', {
        type: 'button',
        className: `dsm-ocsb-row${open ? ' dsm-ocsb-row-selected' : ''}`,
        onClick: () => onSelect(open ? null : model.id),
        'aria-expanded': String(open),
      },
      h('span', { className: 'dsm-ocsb-row-icon', 'aria-hidden': 'true' }, '◆'),
      h('span', { className: 'dsm-ocsb-row-info' },
        h('span', { className: 'dsm-ocsb-row-name' }, model.name),
        h('span', { className: 'dsm-ocsb-row-meta' }, model.id)),
      h('span', { className: 'dsm-ocsb-badges' }, badges)),
      open && h(ModelDetail, { model, t })))
  }
  return h('div', { className: 'dsm-ocsb-list' }, rows)
}

/** The expanded detail panel for one model. */
function ModelDetail({ model, t }) {
  const detail = [
    { text: `${t('detail.context')}：${model.contextWindow ?? '—'}` },
    { text: `${t('detail.output')}：${model.maxOutputTokens ?? '—'}` },
    { text: `${t('detail.images')}：${model.supportsImages ? t('detail.yes') : t('detail.no')}` },
    { text: `${t('detail.tools')}：${model.supportsTools ? t('detail.yes') : t('detail.no')}` },
    {
      text: model.supportsReasoning
        ? `${t('detail.reasoning')}：${t('detail.yes')} · ${(model.supportedEfforts ?? []).length > 0 ? `${t('detail.efforts')} ${model.supportedEfforts.join(' / ')}` : t('detail.default')}`
        : `${t('detail.reasoning')}：${t('detail.no')}`,
    },
  ]
  if (typeof model.blocked === 'string' && model.blocked !== '') detail.push({ text: model.blocked, error: true })

  return h('div', { className: 'dsm-ocsb-detail' },
    h('p', { className: 'dsm-ocsb-detail-id' }, model.id),
    detail.map((line, index) => h('p', {
      key: `${index}-${line.text}`,
      className: line.error ? 'dsm-ocsb-error' : undefined,
    }, line.text)))
}

/** One copyable gateway row. */
function GatewayRow({ label, value, t }) {
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }
  return h('div', { className: 'dsm-ocsb-gwrow' },
    h('span', { className: 'dsm-ocsb-gwlabel' }, `${label}：`),
    h('span', { className: 'dsm-ocsb-gwvalue' }, value),
    h('button', {
      type: 'button',
      className: 'dsm-ocsb-btn dsm-ocsb-btn-outline dsm-ocsb-gwcopy',
      onClick: () => void copy(),
    }, copied ? t('gateway.copied') : t('gateway.copy')))
}

/** The whole settings page. */
function BridgePage(props) {
  const { t } = props
  const [status, setStatus] = React.useState(null)
  const [gateway, setGateway] = React.useState(null)
  const [feedback, setFeedback] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  const [selected, setSelected] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    const read = async () => {
      try {
        const response = await fetch(STATUS_PATH, { headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const next = await response.json()
        if (alive) setStatus(next)
      } catch (error) {
        if (alive) setStatus(previous => previous ?? {
          phase: 'error', message: String(error?.message ?? error), models: [],
          metrics: { discovered: 0, available: 0, blocked: 0 }, dataDir: '',
        })
      }
    }
    void read()
    const timer = setInterval(read, POLL_INTERVAL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const act = async (key, path) => {
    if (busy !== null) return
    setBusy(key)
    setFeedback(null)
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
      if (key === 'refresh') setFeedback({ text: fill(t('feedback.refreshed'), { n: result.visible ?? 0 }) })
      else if (key === 'restart') setFeedback({ text: fill(t('feedback.restarted'), { n: result.visible ?? 0 }) })
      const fresh = await fetch(STATUS_PATH).then(r => (r.ok ? r.json() : null)).catch(() => null)
      if (fresh) setStatus(fresh)
      const gw = await fetch(GATEWAY_PATH).then(r => (r.ok ? r.json() : null)).catch(() => null)
      if (gw) setGateway(gw)
    } catch (error) {
      setFeedback({ text: `${t('error.prefix')}${String(error?.message ?? error)}`, error: true })
    } finally {
      setBusy(null)
    }
  }

  // The gateway card loads once the runtime is ready.
  React.useEffect(() => {
    if (status?.phase !== 'ready') return
    let alive = true
    void fetch(GATEWAY_PATH).then(r => (r.ok ? r.json() : null)).then(gw => {
      if (alive && gw) setGateway(gw)
    }).catch(() => {})
    return () => { alive = false }
  }, [status?.phase])

  const phase = status?.phase ?? 'starting'
  const metrics = status?.metrics ?? { discovered: 0, available: 0, blocked: 0 }

  const action = (key, path, labelKey) => h('button', {
    type: 'button',
    className: `dsm-ocsb-btn ${key === 'refresh' ? 'dsm-ocsb-btn-primary' : 'dsm-ocsb-btn-outline'}`,
    disabled: busy !== null || phase === 'starting',
    onClick: () => void act(key, path),
  }, busy === key
    ? h('span', {}, h('span', { className: 'dsm-ocsb-spinner' }), ` ${t(labelKey)}`)
    : t(labelKey))

  return h('div', { className: 'dsm-ocsb-page' },
    // Header.
    h('div', { className: 'dsm-ocsb-head' },
      h('div', { className: 'dsm-ocsb-headcopy' },
        h('h2', { className: 'dsm-ocsb-title' }, t('page.title')),
        h('p', { className: 'dsm-ocsb-desc' }, t('page.desc'))),
      h('div', { className: 'dsm-ocsb-actions' },
        action('refresh', REFRESH_PATH, busy === 'refresh' ? 'action.refreshing' : 'action.refresh'),
        action('restart', RESTART_PATH, busy === 'restart' ? 'action.restarting' : 'action.restart'))),

    // Service state + runtime facts.
    h('div', { className: 'dsm-ocsb-card' },
      h('div', { className: 'dsm-ocsb-status' },
        h('span', { className: `dsm-ocsb-dot${phase === 'error' ? ' dsm-ocsb-dot-error' : phase === 'starting' ? ' dsm-ocsb-dot-starting' : ''}` }),
        h('span', {}, status?.message ?? t(`status.${phase}`)),
        phase === 'error' && h('button', {
          type: 'button', className: 'dsm-ocsb-btn dsm-ocsb-btn-outline', disabled: busy !== null,
          onClick: () => void act('restart', RESTART_PATH),
        }, t('status.retry'))),
      h('div', { className: 'dsm-ocsb-metrics' },
        h('div', { className: 'dsm-ocsb-metric' }, h('b', {}, String(metrics.discovered)), h('span', {}, t('metric.discovered'))),
        h('div', { className: 'dsm-ocsb-metric' }, h('b', {}, String(metrics.available)), h('span', {}, t('metric.available'))),
        h('div', { className: 'dsm-ocsb-metric' }, h('b', {}, String(metrics.blocked)), h('span', {}, t('metric.blocked')))),
      status !== null && h('div', { className: 'dsm-ocsb-meta' },
        status.runtimeVersion !== undefined && h('span', {}, `${t('runtime.version')}：OpenCode ${status.runtimeVersion}`),
        status.endpoint !== undefined && h('span', {}, `${t('runtime.endpoint')}：${status.endpoint}`),
        status.dataDir !== '' && h('span', {}, `${t('runtime.dataDir')}：${status.dataDir}`))),

    feedback !== null && h('div', { className: 'dsm-ocsb-feedback' }, feedback.text),

    // Model directory.
    h('div', { className: 'dsm-ocsb-card' },
      h('h3', { className: 'dsm-ocsb-cardtitle' }, t('models.title')),
      h('p', { className: 'dsm-ocsb-cardhint' }, t('models.hint')),
      status === null
        ? h('p', { className: 'dsm-ocsb-empty' }, t('models.empty'))
        : h(ModelList, { status, t, selected, onSelect: setSelected })),

    // Gateway direct-access card.
    gateway !== null && h('div', { className: 'dsm-ocsb-card' },
      h('h3', { className: 'dsm-ocsb-cardtitle' }, t('gateway.title')),
      h('p', { className: 'dsm-ocsb-cardhint' }, t('gateway.hint')),
      h(GatewayRow, { label: t('gateway.baseUrl'), value: gateway.baseUrl, t }),
      h(GatewayRow, { label: t('gateway.apiKey'), value: gateway.apiKey, t }),
      h('div', { className: 'dsm-ocsb-meta' },
        h('span', {}, `${t('gateway.models')}：${(gateway.models ?? []).join(' · ')}`))),

    h('p', { className: 'dsm-ocsb-footer' }, t('footer.note')))
}

/**
 * Register the page and its copy. Wrapped so a slot-API change degrades to a
 * console error instead of tripping the host's "failed to load plugins" banner.
 */
function apply(ctx) {
  try {
    const namespace = `settings.${SETTINGS_NS}`
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }))
    const t = ctx.locale.bind(namespace)

    installStyles()

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: SETTINGS_NS,
      order: 451,
      label: () => t('row.navLabel'),
      inject: () => ({ t }),
    }, BridgePage))
  } catch (error) {
    console.error('[dsh-opencode-sdk-bridge] client page failed to load (host provider unaffected):', error)
  }
}

module.exports = { name, inject, apply }
