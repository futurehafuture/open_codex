# Open Codex App

Open Codex App is an open-source desktop app that embeds and talks to the OpenAI Codex CLI agent. It targets Windows and macOS with an Electron UI that mirrors the requested Codex-style layout: a project sidebar, centered prompt composer, a top-right workspace selector, a terminal toggle, and a right tools sidebar toggle.

The upstream agent foundation is [`openai/codex`](https://github.com/openai/codex), described by OpenAI as a lightweight coding agent that runs locally in a terminal. The official Codex desktop app is not open sourced, so this repository builds an independent open-source app layer around the open agent/CLI interface.

## Features

- Cross-platform Electron app for Windows and macOS.
- Drives the open-source `@openai/codex` CLI through the `@openai/codex-sdk`, surfacing structured, typed agent events.
- Chat composer renders replies by type — messages, reasoning, command runs (with exit codes), and file diffs — instead of raw terminal bytes.
- Bring-your-own OpenAI-compatible endpoint: set a Base URL + API key in Settings (key encrypted via Electron `safeStorage`); no login required.
- `打开位置` button for choosing a workspace directory; changing it restarts Codex in that directory.
- Top-right terminal button that opens a separate embedded shell panel.
- Top-right right-sidebar button that reveals tools for 审查, 终端, 浏览器, and 文件.
- Hardened renderer bridge using Electron preload IPC instead of enabling direct Node.js access in the page.

## Development

```bash
npm install
npm start
```

Run static checks:

```bash
npm test
```

## Packaging roadmap

1. Add `electron-builder` or Tauri packaging targets for `.dmg`, `.zip`, `.exe`, and `.msi`.
2. Persist projects, conversations, model settings, approval mode, and branch/worktree metadata.
3. Add rich terminal emulation with xterm.js for ANSI/TUI fidelity.
4. Add file browser, browser preview, review panel, and Codex automation/plugin views.


## Agent architecture

The app drives the official Codex engine through structured events instead of scraping the terminal UI:

1. `src/main/engine/` wraps the engine behind one normalized event contract: `sdkAdapter.js` (the default, via `@openai/codex-sdk` → `codex exec --json`) and `appServerAdapter.js` (the `codex app-server` JSON-RPC control plane, reserved for interactive approvals later). `createEngine()` selects the adapter.
2. `src/main.js` exposes `engine:*` IPC (check / start / prompt / interrupt) and forwards every normalized event to the renderer as `engine:event`. The embedded shell panel still uses `node-pty` (`terminal:*`).
3. `src/renderer/ui/agentView.js` renders those events by type — agent messages, reasoning, command runs, file diffs, and to-do lists — building every node with `textContent` so agent output is never parsed as HTML.
4. `src/preload.js` is the hardened `openCodex` bridge between the page and the main process.

### Persistence

Projects, threads, and messages are stored in SQLite (`better-sqlite3`) under the app's user-data directory (`src/main/store/`). The main process writes transparently: a thread row is created lazily on the first prompt, the engine thread id is captured for resume, and completed agent items are saved for later review. The sidebar lists real projects/threads; clicking one replays its saved messages and resumes the engine thread. `better-sqlite3` is a native module — run `npm run rebuild` after install; if it isn't built, persistence degrades to a no-op and live chat still works.

### Bring your own OpenAI-compatible endpoint

There is no in-app login. Open the **设置 / Settings** panel and enter a **Base URL** and **API Key** for any OpenAI-compatible service (plus an optional model name). The key is stored encrypted at rest with Electron `safeStorage` in the app's user-data directory; the renderer only ever learns whether a key is set, never its value. Under the hood the SDK turns the Base URL into `--config openai_base_url=...` and the key into the `CODEX_API_KEY` environment variable for the Codex CLI.
