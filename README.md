# DSH OpenCode SDK Bridge

This plugin integrates **OpenCode Zen's free models** into DeepSeek Harness. It runs a managed, isolated `opencode serve` child process (with stdout port sniffing), uses the official **@opencode-ai/sdk** for transport, exposes a loopback OpenAI-compatible gateway with SSE, and registers native model providers through the Harness LLM seam.

## Overview

- **Isolation**: Runs the OpenCode runtime in its own XDG home, protecting user configs.
- **Port Sniffing**: Automatically detects the `opencode serve` listening port from stdout.
- **Gateway**: Provides a local OpenAI-compatible endpoint (`/v1`) with full SSE support.
- **Provider Registration**: Registers native `OpenCode SDK Bridge` provider(s) for model selection within the Harness UI.
- **Zero-Cost Check**: Automatically delists a model from the catalog the moment upstream marks it as non‑free.
- **Settings UI**: Includes a **OpenCode SDK Bridge** settings card under *Settings → Plugins* showing runtime status, model directory, and direct access URLs.

## Overview

### Directory Structure

```
📁 dsh-opencode-sdk-bridge/
│
├─ 📄 package.json               // Bundle metadata, peer deps, build scripts
├─ 📄 tsconfig.json              // Strict TypeScript compiler options
├─ 📄 tsconfig.typecheck.json    // Isolated typecheck config (peer stubs)
├─ 📄 cordis.patch.yml           // Injects plugin entry into Harness
├─ 📁 src/                      // Source code
│   ├─ 📄 index.ts               // Host plugin entry (apply, Config, lifecycle)
│   ├─ 📄 platform.ts            // Data‑dir resolution, binary detection
│   ├─ 📄 models.ts              // Hardcoded free model list + Catalog enrichment
│   ├─ 📄 sdk.ts                  // Thin @opencode-ai/sdk wrapper (auth, session, prompt)
│   ├─ 📄 protocol.ts            // Completion preparation + BridgeError
│   ├─ 📄 process.ts             // Runtime start, port sniffing, graceful stop
│   ├─ 📄 gateway.ts             // Loopback OpenAI‑compatible gateway (SSE + JSON)
│   ├─ 📄 backend.ts             // Turn execution: intercept native actions → SDK
│   ├─ 📄 adapter.ts              // PiAiAdapter registration (native ↔ gateway)
│   └─ 📁 client/                // Browser‑side React settings page
│       └─ 📄 index.js           // CJS module for host’s module‑loader
├─ 📁 scripts/                   // Build helpers
│   └─ 📄 build-client.mjs       // Wraps client CJS for the host
├─ 📁 lib/                      // Compiled outputs (committed to git)
├─ 📄 README.md                  // This document
├─ 📄 LICENSE                   // MIT
└─ 📄 .gitignore
```

## Installation (in DSH profile)

1. **Profile switch** to the desktop profile (`dsh profiles switch desktop`).
2. **Install the bundle**:
   ```bash
   dsh plugin install file:@./dsh-opencode-sdk-bridge
   ```
3. **Enable the bundle** (if it’s installed but disabled):
   ```bash
   dsh plugin enable dsh-opencode-sdk-bridge
   ```
4. **Verify** that the *OpenCode SDK Bridge* section appears under *Settings → Plugins*.

## Compilation

The plugin ships with its source TypeScript already compiled into `lib/` to avoid runtime compilation.

- **Full build** (source → lib + client):
  ```bash
  npm run build
  ```
- **Type‑only check** (isolated, uses peer‑dependency stubs):
  ```bash
  npm run typecheck
  ```
- **Clean**:
  ```bash
  npm run clean
  ```

### Build Steps Explained

1. **TypeScript → `lib/`**
   ```bash
   npx tsc -p tsconfig.json
   ```
   Generates the host runtime (`lib/index.js`) and all helper modules.

2. **Client bundle** (`lib/client.js`)
   ```bash
   node scripts/build-client.mjs
   ```
   Wraps the React settings page in the host’s module‑loader factory shape (`window.__ModuleLoader__.load(...)`).

## Plugin Configuration

The plugin exposes a `Config` object with the following keys:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dataDir` | `string` | `<DSH home>/.dsh/opencode-sdk-bridge` | Directory for runtime binary, logs, and gateway info. |
| `binaryPath` | `string` | auto‑resolved | Path to an existing OpenCode executable (falls back to `xdbridge runtime` → `~/.opencode/bin` → `PATH`). |
| `port` | `number` | `0` | Fixed port for `opencode serve` (`0` = random, sniffed from stdout). |
| `gatewayPort` | `number` | `0` | Fixed port for the local OpenAI‑compatible gateway (`0` = random). |
| `extraModels` | `string[]` | `[]` | Additional OpenCode model IDs to append to the free‑model catalog. |

All values are optional; missing fields are populated with defaults.

## Runtime Lifecycle

- **Starting** → the plugin attempts to locate or download the OpenCode binary, spawns the `opencode serve` child, and sniffs its HTTP port from stdout.
- **Ready** → the gateway endpoint (`/v1`) is listening, the model catalog is populated with the five free models (or any `extraModels`), and the native provider is registered.
- **Error** → any fatal failure stops the plugin and reports the error message in the settings UI; the plugin continues to retry on next start.
- **Stopped** → triggered by DSH profile unload or plugin deactivation; the child process and gateway are gracefully terminated.

## Settings UI Features

1. **Status Card**
   - Phase indicator (starting/ready/error/stopped).
   - Metrics: total discovered, available, and delisted models.
   - Runtime version, endpoint, and data directory.

2. **Model Directory**
   - List of available free models with capability badges (reasoning, images, tools).
   - Delisted models are greyed‑out and shown only in a collapsed detail panel.
   - Click a row to expand its detailed metadata (context window, output limit, variant efforts).

3. **Actions**
   - **Read models**: triggers an on‑demand enrichment from the live runtime.
   - **Restart runtime**: restarts the isolated OpenCode process (provider is re‑registered automatically).

4. **Gateway Direct‑Access**
   - Read‑only cards with the base URL and API key for external OpenAI‑compatible clients.
   - Copy buttons for one‑click endpoint/key injection.

5. **Footer**
   - Disclaimer that the free‑model list is managed by OpenCode Zen and subject to change.

## Native Provider Registration

The plugin registers a PiAiAdapter named **OpenCode SDK Bridge** that forwards every chat completion request to the gateway endpoint (`http://127.0.0.1:<gatewayPort>/v1/chat/completions`). The adapter is added automatically to the *OpenAI* provider group in the model selector.

## Model Catalog Details

Five models are hardcoded as the free‑model baseline:

| Model ID | Display Name |
|----------|--------------|
| `deepseek‑v4.1‑flash‑free` | DeepSeek V4.1 Flash Free |
| `big‑pickle` | Big Pickle |
| `glm‑5.3‑flash‑free` | GLM 5.3 Flash Free |
| `mimo‑v2.6‑flash‑free` | MiMo v2.6 Flash Free |
| `nemotron‑3‑ultra‑free` | Nemotron 3 Ultra Free |

Each model is presented in the catalog under the `opencode` provider prefix (`opencode/<id>`). The catalog is enriched in real time from the runtime’s `/provider` endpoint, pulling:

- Context window & output limits.
- Capability flags (`images`, `tool_call`, `reasoning`).
- Reasoning‑effort variants (if the model supports them).
- **Zero‑cost verification**: a model is immediately delisted if the runtime reports any non‑zero price in `cost.input`, `cost.output`, `cost.cache_read`, or `cost.cache_write`.

## Protocol Translation

The plugin speaks the official OpenCode SDK channel:

1. **Auth** – The child process is launched with `OPENCODE_SERVER_USERNAME=opencode` and a password generated by the plugin; the SDK client uses HTTP Basic auth.
2. **Session & Prompt** – For each user turn, the plugin:
   - Creates (or reuses) an SDK session.
   - Sends a `prompt` that describes the DSH turn, including any native tool calls that need interception.
   - Captures the structured `AssistantMessage` and forwards it to the gateway.
3. **Streaming** – The gateway supports both traditional JSON POST bodies and Server‑Sent Events for streaming.
4. **Error Handling** – All upstream errors are unwrapped into `BridgeError` instances with appropriate HTTP status codes for the outer gateway.

## Build Scripts

| Script | Description |
|--------|-------------|
| `build` | `tsc -p tsconfig.json` → `lib/` + `node scripts/build-client.mjs` |
| `build:client` | `node scripts/build-client.mjs` (regenerates `lib/client.js`) |
| `typecheck` | `tsc -p tsconfig.typecheck.json` (isolated, uses stub peers) |
| `clean` | `rm -rf lib` |

## Dependencies

### Runtime Dependencies

- `@opencode-ai/sdk` (`^1.19.3`) – The official client for the OpenCode service.

### Peer Dependencies (optional, provided by DSH profile)

- `@deepseek-ai/cordis` (`^4.0.2`) – Plugin API (`apply`, `Config`, `inject`).
- `@deepseek-ai/dsh-llm` (`>=0.1.1-rc.1 <0.2.0`) – Provider infrastructure.
- `@deepseek-ai/dsh-llm-pi-ai` (`>=0.1.1-rc.1 <0.2.0`) – PiAiAdapter utilities.
- `@deepseek-ai/schemastery` (`^4.0.0`) – Schema definitions.
- `@earendil-works/pi-ai` (`>=0.82.1 <0.86.0`) – Provider factory.

### Development Tools

- `@types/node` (`^24.12.2`)
- `typescript` (`^5.9.2`)

## Installation (in DSH profile)

1. **Profile switch** to the desktop profile (`dsh profiles switch desktop`).
2. **Install the bundle**:
   ```bash
   dsh plugin install file:@./dsh-opencode-sdk-bridge
   ```
3. **Enable the bundle** (if it’s installed but disabled):
   ```bash
   dsh plugin enable dsh-opencode-sdk-bridge
   ```
4. **Verify** that the *OpenCode SDK Bridge* section appears under *Settings → Plugins*.

## Profile Config (Desktop)

In `profiles/desktop/package.json`, add the plugin to `dsh.profile.bundles` and use a workspace alias:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-opencode-xdbridge",
        "dsh-our-free-model",
        "dsh-opencode-sdk-bridge"
      ]
    }
  },
  "dependencies": {
    "dsh-opencode-sdk-bridge": "workspace:*"
  }
}
```

Then:
```bash
cd profiles/desktop
pnpm install
```

## License

MIT – see `LICENSE`.
