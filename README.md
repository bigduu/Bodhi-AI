# Bodhi AI

> 📖 中文版请看 **[README.zh-CN.md](./README.zh-CN.md)**

> The desktop AI workbench
>
> This module is the **desktop shell (Tauri) and product surface** within the Zenith monorepo.

---

## The Hook

Bodhi AI turns AI from a chat box into a **desktop work system that actually moves work forward**. You hand it a goal; it breaks the goal into steps, runs tools, reads and writes files, connects to your systems — and **shows every step of its work** instead of just handing you a wall of text. Better still: a one-off useful run can be saved as a reusable workflow, and a workflow can be put on a schedule. AI stops being a disposable answer and becomes an assistant that **compounds in value over time**.

It installs and runs as a real desktop app (Windows / macOS / Linux), with a global hotkey, native notifications, and a local engine running inside the app — no separate server to babysit.

---

## Key Capabilities at a Glance

| Capability | What it does |
|---|---|
| 🖥️ Native desktop shell | A real desktop app window (Tauri 2), cross-platform packaging (`bundle.targets: all`) |
| ⌨️ Global hotkey | `Cmd/Ctrl + Shift + Space` shows/hides the main window anytime |
| 🔌 Embedded engine | Runs the Bamboo runtime HTTP service directly inside the app (default port `9562`), no separate sidecar process |
| 🔔 Native notifications | Pushes desktop alerts through the system notification center |
| 📋 Clipboard | Native clipboard writes (macOS / Windows) |
| 🌐 Proxy config | Reads/writes HTTP/HTTPS proxy and auth, persisted to `config.json` |
| 🎨 Window theme | Follows the frontend to switch light/dark/system theme |
| 📦 Lotus asset staging | Chooses the frontend source between local source or npm package via `LOTUS_SOURCE` |
| 🏢 Build modes | Internal builds show a confirmation dialog at startup; public builds boot straight in |

---

## Architecture

Bodhi owns only the shell and the product surface — the desktop window, native integrations (clipboard, notifications, global shortcut, proxy), packaging and release. The UI comes from **Lotus**; the real execution engine is **Bamboo** (a local-first Rust agent runtime). The key detail: Bodhi **compiles the Bamboo engine directly into the app process** (via the `bamboo-agent` crate dependency) and starts an embedded HTTP service at launch. The Lotus frontend then talks to that local service over HTTP — the same boundary you'd get with a standalone backend.

```mermaid
graph TD
  subgraph Desktop["Bodhi AI desktop app (Tauri 2)"]
    L["Lotus UI<br/>React + Vite assets<br/>(WebView)"]
    E["Embedded WebService<br/>bamboo-agent HTTP server<br/>127.0.0.1:9562"]
    N["Native commands<br/>clipboard · notifications<br/>proxy · window theme"]
    L -- "HTTP /api/v1/*" --> E
    L -- "Tauri IPC invoke" --> N
  end
  E -. "LLM proxy / auth / quota (optional)" .-> S["bodhi-server (Go)"]
```

**Where this sits in Zenith:**

- **`bodhi`** — desktop AI product surface (this module)
- **`lotus`** — the React + Vite UI layer
- **`bamboo`** — the local-first Rust agent runtime (execution engine)
- **`bodhi-server`** — Go backend: auth, persistence, billing+quota, LLM proxy
- **`pavilion`** — official website & docs
- **Zenith (root)** — monorepo entry, submodule pointers, release train

---

## Signature Deep-Dives

### From chat box to work system

This is the product pitch. Ordinary AI hands you text and stops; Bodhi advances a goal into an outcome:

- **Run** — driven by the agent loop: understand the goal → call tools → read/write files / search / execute → pause at approval points → keep moving forward. The process is visible to you (tasks, tool calls, events, state changes).
- **Workflow** — a one-off useful run can be saved as a reusable behavior, then re-run with one click next time.
- **Schedule** — a workflow can be attached to a timed schedule to run automatically.

> Note: the run / workflow / schedule capability — and all tools and agent logic — live in the **Bamboo runtime**. Bodhi's job is to wrap it in a **desktop product you can actually use every day**.

### Embedded runtime, not a sidecar

`EmbeddedWebService` in `src-tauri/src/embedded/mod.rs` runs `bamboo-agent::server::WebService` directly inside the app process:

- **Default port `9562`** (`DEFAULT_WEB_SERVICE_PORT`, defined in `src-tauri/src/lib.rs`).
- **Skip if the port is taken**: before starting, it probes `http://127.0.0.1:9562/api/v1/health`; if a backend is already running (e.g. you manually started a standalone bamboo server), it skips the embedded startup, making it easy to debug frontend and backend independently.
- **Health check**: after starting, it polls `/api/v1/health`, with up to 10 retries before it is considered ready.
- **Self-managed static assets**: prefers Bamboo's bundled frontend directory, falling back to `.lotus-dist` and other candidate paths; when no frontend is found it starts in **API-only mode**.
- **Configurable bind address**: read from `server.bind` in `config.json` (default `127.0.0.1`).

> Why it matters: a user opens one app and the engine comes up with it; a developer can still run the backend externally for debugging. Best of both.

### Native desktop integrations

The following Tauri commands are registered in `src-tauri/src/lib.rs` (`invoke_handler`), each with a real implementation:

| Tauri command | Source | Purpose |
|---|---|---|
| `copy_to_clipboard` | `command/copy.rs` | Native clipboard write (falls back to the Web API on Linux) |
| `show_desktop_notification` | `command/notification.rs` | System desktop notification |
| `get_proxy_config` / `set_proxy_config` | `command/proxy.rs` | Read/write proxy config + auth, persisted to `config.json` |
| `set_window_theme` | `command/window.rs` | Set window theme (light/dark/system) |
| `is_main_window_focused` | `command/window.rs` | Query whether the main window is focused |
| `mark_setup_incomplete` | `command/setup.rs` | Mark initialization as incomplete (reset onboarding) |

Enabled Tauri plugins: `dialog`, `fs`, `global-shortcut`, `shell`, `process`, `notification`.

Global shortcut: **macOS** `Cmd+Shift+Space`, **Windows/Linux** `Ctrl+Shift+Space` — toggles the main window show/hide.

### Choosing the Lotus frontend source

Bodhi has no frontend source of its own — it **stages** Lotus assets at build/dev time (`scripts/lotus-dist.cjs`, output to `.lotus-dist/`). The source is controlled by env vars:

| Variable | Default | Description |
|---|---|---|
| `LOTUS_SOURCE` | `auto` | `auto` \| `local` \| `package`. `auto` prefers the local `../lotus`, otherwise uses the npm package |
| `LOTUS_LOCAL_PATH` | `../lotus` | Local Lotus checkout path |
| `LOTUS_PACKAGE_NAME` | `@bigduu/lotus` | Published Lotus npm package name |

### Internal vs public build mode

`is_internal_build_mode()` reads the compile-time `option_env!("BODHI_INTERNAL_BUILD")` or runtime `BODHI_INTERNAL_BUILD`. Internal builds show a startup confirmation dialog; public builds boot straight in. Frontend rebranding is driven by Lotus's rebrand scripts (`npm run rebrand:public` / `rebrand:internal`, proxied from `bodhi/package.json`).

---

## Quick Start & Development

> All commands below are verified to exist in `bodhi/package.json` / `Cargo.toml`.

### Prerequisites
- Node.js + npm (frontend toolchain)
- Rust toolchain (Tauri backend)
- a sibling `../lotus` checkout or the installed `@bigduu/lotus` package

### Develop

```bash
# from the bodhi/ directory
npm run tauri:dev
```

`tauri:dev` first runs `web:dev` (`cd ../lotus && npm run dev`), then launches the Tauri dev window (`devUrl: http://localhost:1420`).

Branded dev variants:

```bash
npm run tauri:dev:public      # public mode
npm run tauri:dev:internal    # internal mode (startup confirmation)
```

### Build

```bash
npm run tauri:build           # production bundle (bundle.targets: all)
npm run tauri:build:public    # public-mode bundle
npm run tauri:build:internal  # internal-mode bundle
```

`tauri:build`'s `beforeBuildCommand` builds Lotus and stages its output into `.lotus-dist/` (`frontendDist: ../.lotus-dist`).

### Stage frontend assets only

```bash
npm run web:build             # build Lotus and stage into .lotus-dist
npm run web:source:info       # print the current Lotus source (local/package + LOTUS_SOURCE)
```

### Run frontend & backend separately

Because the embedded service skips startup when the port is busy, you can run a standalone backend for debugging. The Bamboo backend entry point is the `serve` subcommand of the `bamboo` binary (in the `bamboo/` directory):

```bash
# Terminal 1: backend (in bamboo/)
cargo run --bin bamboo -- serve --port 9562

# Terminal 2: frontend (in lotus/)
npm run dev
```

`serve` accepts: `--port`, `--bind`, `--data-dir`, `--static-dir`, `--workers`.

### Runtime diagnostic env vars

> These are actually read and honored in `src-tauri/src/lib.rs`.

| Variable | Effect |
|---|---|
| `BODHI_OPEN_DEVTOOLS` | Open devtools on launch when truthy |
| `BODHI_WEBVIEW_DIAG` | Inject a diagnostics overlay if the frontend fails to mount, when truthy |
| `BODHI_INTERNAL_BUILD` | Enable the internal-build startup confirmation dialog when truthy |
| `BODHI_FRONTEND_DIST` | Explicit static frontend dir for the embedded service |

Proxy auth also honors `PROXY_USERNAME` / `PROXY_PASSWORD` (see `command/proxy.rs`).

> Note: this module does NOT define `type-check` / `test:run` / `test:e2e` — those belong to **Lotus**. Bodhi's `package.json` only contains the web/rebrand/tauri scripts listed above.

---

## The Rest of the Stack

| Module | Role | Link |
|---|---|---|
| **lotus** | React + Vite UI layer | [`../lotus`](../lotus) |
| **bamboo** | local-first Rust agent runtime | [`../bamboo`](../bamboo) |
| **bodhi-server** | Go backend: auth / persistence / billing+quota / LLM proxy | [`../bodhi-server`](../bodhi-server) |
| **pavilion** | official website & docs | [`../pavilion`](../pavilion) |
| **Zenith (root)** | monorepo entry & release train | [`../`](../) |

---

<sub>Version: `2026.4.24` (see `package.json` / `tauri.conf.json` / `Cargo.toml`) · Identifier: `com.bodhi.app` · verified against source; source is the source of truth.</sub>
