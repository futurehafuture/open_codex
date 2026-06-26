# Open Codex App

Open Codex App is an open-source desktop app that embeds and talks to the OpenAI Codex CLI agent. It targets Windows and macOS with an Electron UI that mirrors the requested Codex-style layout: a project sidebar, centered prompt composer, a top-right workspace selector, a terminal toggle, and a right tools sidebar toggle.

The upstream agent foundation is [`openai/codex`](https://github.com/openai/codex), described by OpenAI as a lightweight coding agent that runs locally in a terminal. The official Codex desktop app is not open sourced, so this repository builds an independent open-source app layer around the open agent/CLI interface.

## Features

- Cross-platform Electron app for Windows and macOS.
- Bundles the open-source `@openai/codex` CLI package and starts a real Codex agent session when the app opens.
- Chat composer sends prompts directly into the running Codex agent process.
- Live agent output panel streams Codex CLI output back into the app.
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

The app now has a real agent path instead of only a visual shell:

1. `src/main.js` resolves the Codex CLI from the bundled `node_modules/.bin/codex`, `OPEN_CODEX_CLI`, or the user PATH.
2. The main process starts Codex with `node-pty` so the agent can run interactively in the selected workspace.
3. `src/preload.js` exposes a minimal `openCodex` bridge for starting, prompting, resizing, and disposing Codex sessions.
4. `src/renderer.html` starts the Codex agent on app load and sends composer input to the live agent.

Codex authentication is handled by the upstream CLI. The first run may ask the user to sign in with ChatGPT or configure an API key, matching official Codex CLI behavior.
