# Dual Startup Modes Guide

This project supports two startup modes to accommodate different development needs.

## Repository Layout

- `bodhi/`: Tauri shell (desktop packaging + native integrations)
- `lotus/`: standalone frontend (React + Vite)
- `bamboo/`: standalone HTTP backend (`bamboo serve`)

## Integrated Mode (Default)

This is the simplest and recommended local development approach.

**Startup Command:**
```bash
cd bodhi && npm run tauri:dev
```

In this mode, the Tauri app starts and manages its embedded backend automatically.

## Standalone Mode (Frontend/Backend Separation)

Use this mode when you want to debug frontend and backend independently.

### 1) Start Backend Service

Run from the workspace root:

```bash
cargo run --manifest-path bamboo/Cargo.toml --bin bamboo -- serve --port 9562 --bind 127.0.0.1 --data-dir /tmp/bamboo-data
```

#### Headless Auth Mode

In terminal-only or CI environments, enable headless auth:

```bash
COPILOT_CHAT_HEADLESS=1 cargo run --manifest-path bamboo/Cargo.toml --bin bamboo -- serve --port 9562 --bind 127.0.0.1 --data-dir /tmp/bamboo-data
```

### 2) Start Frontend Dev Server

In another terminal:

```bash
cd lotus && npm run dev
```

## Port Configuration

- Default backend port for local HTTP mode: `9562`
- Frontend dev server port: `1420`

You can change backend port by passing `--port` to `bamboo serve`.

## E2E Tests

- E2E lives in `lotus/e2e`
- Auto-start backend mode uses `bamboo serve`

```bash
cd lotus && npm run test:e2e:with-server
```
