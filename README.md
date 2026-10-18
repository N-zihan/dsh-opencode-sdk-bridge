# DSH OpenCode SDK Bridge

把 **OpenCode Zen 的免费模型**接进 DeepSeek Harness：托管一个隔离的 `opencode serve` 子进程（stdout 端口嗅探），用官方 **@opencode-ai/sdk** 做传输，在本地回環地址暴露 OpenAI 兼容网关（带 SSE 流式），并以原生 provider 的身份注册进 Harness 的模型选择器，同时提供一个设置页 UI。

## 功能一览

- **隔离运行**：OpenCode 运行时跑在独立的 XDG 根目录里，用户自己的 OpenCode 数据库、会话与配置不被读写（例外：auth.json 登录凭据会只读复制，见下文协议一节）。
- **端口嗅探**：自动从 stdout 日志解析 `opencode serve` 的真实监听端口，避免固定端口特征冲突。
- **本地网关**：提供 OpenAI 兼容端点（`/v1/chat/completions`），JSON 与 SSE 双模式，仅允许回环访问，用随机生成的 Bearer key 鉴权。
- **原生注册**：把模型以原生 provider 注册进 Harness，模型选择器里直接可选。
- **零成本校验**：上游目录一旦把某模型标成收费，立即从目录里下架，绝不出现"免费额度跑收费模型"的账单。
- **设置页 UI**：设置里出现 **OpenCode·SDK** 独立版块——运行状态、模型目录（能力徽章）、运行时重启按钮、网关直连凭据。

## 目录结构

```
📁 dsh-opencode-sdk-bridge/
│
├─ 📄 package.json               // 包元数据、peer 依赖、构建脚本
├─ 📄 cordis.patch.yml           // 把插件入口注入 Harness
├─ 📄 pnpm-workspace.yaml
├─ 📄 tsconfig.json              // 严格模式 TypeScript 编译配置
├─ 📄 tsconfig.typecheck.json    // 独立类型检查配置（用 stubs 补 peer 类型）
├─ 📁 src/                       // 源码
│   ├─ 📄 index.ts               // 宿主插件入口（apply、Config、生命周期）
│   ├─ 📄 platform.ts            // 数据目录解析、二进制探测与版本校验
│   ├─ 📄 models.ts              // 硬编码免费名单 + 实时目录增补
│   ├─ 📄 sdk.ts                 // @opencode-ai/sdk 薄封装（鉴权、会话、prompt、事件流）
│   ├─ 📄 protocol.ts            // 请求准备 + BridgeError + 信封协议
│   ├─ 📄 process.ts             // 运行时启动、端口嗅探、凭据同步、优雅退出
│   ├─ 📄 gateway.ts             // 本地 OpenAI 兼容网关（SSE + JSON）
│   ├─ 📄 backend.ts             // 单回合执行：拦截原生动作 → 信封校验 → 纠错
│   ├─ 📄 adapter.ts             // PiAiAdapter 注册（原生 ↔ 网关）
│   ├─ 📄 web-status.ts          // 设置页同源数据路由（status/gateway/refresh/restart）
│   └─ 📁 client/
│       └─ 📄 index.js           // 设置页 React 源码（由构建脚本包装）
├─ 📁 scripts/
│   └─ 📄 build-client.mjs       // 把设置页包装进宿主 module-loader 形态
├─ 📁 stubs/                     // 仅为 typecheck 提供的 peer 声明
├─ 📁 lib/                       // 编译产物（随 git 提交）
├─ 📄 README.md
├─ 📄 LICENSE                    // MIT
└─ 📄 .gitignore
```

## 编译

源码以编译后的形态随仓库提交（`lib/` 入库），运行时无需再编译。

```bash
# 完整构建：TypeScript → lib/ + 生成设置页 bundle lib/client.js
npm run build

# 仅类型检查（隔离配置，使用 stubs 中的 peer 声明）
npm run typecheck

# 清空 lib/
npm run clean
```

两步构建分别对应：

1. `npx tsc -p tsconfig.json` —— 编译出宿主运行时 `lib/index.js` 与全部辅助模块；
2. `node scripts/build-client.mjs` —— 把设置页包装成宿主 module-loader 的工厂形态
   （`window.__ModuleLoader__.load({ id, factory })`）。

## 打包与安装

```bash
# 打包
npm pack   # 产出 dsh-opencode-sdk-bridge-<版本>.tgz
```

在 DSH 中安装：把 tarball 通过 DSH 的插件管理装入当前 profile（或按下面的
"接入 profile" 方式把它写进 profile 依赖），随后**重启 DSH** 生效——设置页新的
`dsh.client` 声明只能在宿主启动时被编入客户端图。

## 接入 profile

在 `profiles/<你的profile>/package.json` 里把插件加进 `dsh.profile.bundles` 和依赖：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // …既有条目…,
        "dsh-opencode-sdk-bridge"
      ]
    }
  },
  "dependencies": {
    "dsh-opencode-sdk-bridge": "file:../../dsh-opencode-sdk-bridge"
  }
}
```

然后 `pnpm install` 并重启 DSH。前置条件：本机需要有一个可用的 OpenCode 二进制
（插件不自带下载）——优先复用 `dsh-opencode-xdbridge` 已下载的托管 runtime，其次
`~/.opencode/bin`，最后是 `PATH` 上的 `opencode`。

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `dataDir` | `string` | `<DSH home>/opencode-sdk-bridge` | 存放托管运行时的 XDG 根、日志与网关信息文件。 |
| `binaryPath` | `string` | 自动解析 | 直接指定 OpenCode 可执行文件。 |
| `port` | `number` | `0` | `opencode serve` 的固定端口；`0` = 随机（从 stdout 嗅探）。 |
| `gatewayPort` | `number` | `0` | 本地网关的固定端口；`0` = 随机。 |
| `extraModels` | `string[]` | `[]` | 在硬编码免费名单之外追加的 OpenCode 模型 id。 |

全部可选，缺省即用默认值。

## 设置页 UI

打开 **设置 → 侧边栏 "OpenCode·SDK"**（排在社区插件区域）：

1. **状态卡** —— 运行阶段（启动中/就绪/出错/已停止）、模型计数（发现/可用/已下架）、运行时版本与服务端口、数据目录。
2. **模型目录** —— 每个免费模型一张卡，带能力徽章（推理/图像/工具调用）；点开可见上下文窗口、输出上限与推理档位；被零成本校验下架的模型会折叠展示。
3. **操作** —— "读取模型"（即时向运行时增补目录）与"重启运行时"（重建隔离进程，provider 自动重指向新端口）。
4. **网关直连** —— 只读展示网关 URL 与 API key，一键复制，给外部 OpenAI 兼容客户端直接使用。

## 工作原理速览

| 环节 | 做法 |
|------|------|
| 免费层准入 | 免费模型必须经由真实 OpenCode 运行时访问；权限策略保持 `{'*': 'ask'}`（实测矩阵：deny 具体动作没关系，`'*'` 必须是 ask） |
| 登录凭据 | `startRuntime` 把用户自己的 `~/.local/share/opencode/auth.json` 只读复制进隔离根（上游 2026-10-18 之后要求登录态，缺失即 FreeTierError） |
| 信封协议 | 每回合：开 SDK 会话 → 发 prompt 要求 JSON 信封 `{content, calls}` → 拦截一切原生权限请求并**拒绝**（本地绝不真正执行）→ 校验信封后才转成外部动作 |
| 畸形输出 | 一次有界纠正重试（含截断场景的压缩重发），再失败才报错 |
| 网关 | `http://127.0.0.1:<port>/v1/chat/completions`，Bearer key 鉴权，仅回环可达，JSON/SSE 双模式 |
| 直连凭据 | 写在 `<dataDir>/gateway.json`，设置页读取展示 |

## 模型目录

内置五个免费模型：

| 模型 id | 显示名 |
|---------|--------|
| `deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash Free |
| `big-pickle` | Big Pickle |
| `glm-5.3-flash-free` | GLM 5.3 Flash Free |
| `mimo-v2.6-flash-free` | MiMo v2.6 Flash Free |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra Free |

目录在运行时启动后按 `opencode/<id>` 前缀注册，并从运行时 `/provider` 端点实时增补：
上下文窗口、输出上限、能力位（`images` / `tool_call` / `reasoning`）、推理档位变体；
`extraModels` 配置可随时追加。**零成本校验**：只要 `cost.*` 任一字段非零，立即下架。

## 排障

| 现象 | 说明 |
|------|------|
| `FreeTierError: OpenCode's free tier can only be used from within OpenCode` | 上游拒绝，两步自查：确认 `opencode auth login` 登录过 OpenCode（凭据会被自动同步）；用官方 v2 客户端对同一模型发一条消息对照。若官方客户端同样报错，则为上游侧限制，只能等恢复或给账号充值走付费模型。该错误归一化为 503（`upstream_gate`），不做自动重试。 |
| 网关返回 502「上游 OpenCode Zen 服务端故障」或「与上游的连接中断」 | 上游瞬时故障（5xx / 流被掐断）的规范化提示：插件已自动带退避重试一次；仍失败说明上游服务端还在出 500，通常几分钟内自愈，稍后再试即可。 |
| 设置页没出现插件版块 | 安装/升级后需要完整重启 DSH：`dsh.client` 声明只在宿主启动时编入客户端图。 |
| 端口被占用 | 配置里把 `port` / `gatewayPort` 指到固定空闲端口，或维持 `0` 走随机。 |
| 找不到二进制 | 先 `npm i -g opencode-ai`，或让 `dsh-opencode-xdbridge` 下载一次 runtime，或配置 `binaryPath`。 |
| 运行时日志 | 插件层：`<dataDir>/opencode.log`；运行时内部：`<dataDir>/opencode/data/opencode/log/opencode.log`。 |

## 开发脚本

| 脚本 | 作用 |
|------|------|
| `build` | `tsc -p tsconfig.json` → `lib/`，再 `node scripts/build-client.mjs` |
| `build:client` | 只重新生成 `lib/client.js` |
| `typecheck` | `tsc -p tsconfig.typecheck.json`（隔离，使用 stubs） |
| `clean` | 清空 `lib/` |

## 依赖

- **运行时依赖**：`@opencode-ai/sdk`（`^1.19.3`，OpenCode 官方客户端）
- **peer 依赖**（可选，由 DSH 宿主提供）：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、
  `@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/schemastery`、`@earendil-works/pi-ai`
- **开发依赖**：`typescript`、`@types/node`

## 许可证

MIT —— 见 `LICENSE`。
