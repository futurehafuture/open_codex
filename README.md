# Open Codex App

Open Codex App is an open-source desktop shell for the OpenAI Codex CLI agent. It targets Windows and macOS with an Electron UI that mirrors the requested Codex-style layout: a project sidebar, centered prompt composer, a top-right workspace selector, a terminal toggle, and a right tools sidebar toggle.

The upstream agent foundation is [`openai/codex`](https://github.com/openai/codex), described by OpenAI as a lightweight coding agent that runs locally in a terminal. The official Codex desktop app is not open sourced, so this repository builds an independent open-source app layer around the open agent/CLI interface.

## Features

- Cross-platform Electron shell for Windows and macOS.
- Codex-inspired Chinese desktop layout matching the provided reference screenshots.
- `打开位置` button for choosing a workspace directory.
- Top-right terminal button that opens an embedded shell panel.
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
2. Replace the shell prototype with a real Codex CLI session adapter.
3. Persist projects, conversations, model settings, approval mode, and branch/worktree metadata.
4. Add file browser, browser preview, review panel, and Codex automation/plugin views.
