'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

const { createEngine, resolveCodexCommand, checkAgent, EngineMode } = require('./main/engine');
const configStore = require('./main/config/store');
const { createLogger } = require('./main/util/logger');

const log = createLogger('main');
const isMac = process.platform === 'darwin';

let mainWindow = null;
/** Lazily-built engine adapter; rebuilt whenever settings change. */
let engine = null;
/** id -> node-pty terminal (kept for the embedded shell panel). */
const terminals = new Map();
let nextTerminalId = 1;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    title: 'Open Codex',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
}

function shellForPlatform() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

function codexPath() {
  return resolveCodexCommand(app.getAppPath());
}

function sendToWindow(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

/** Forward every normalized engine event to the renderer. */
function forwardEngineEvent(event) {
  sendToWindow('engine:event', event);
}

/** Build (or reuse) the engine adapter from the current saved settings. */
function getEngine() {
  if (engine) return engine;
  const settings = configStore.loadSettings();
  engine = createEngine(settings.engineMode || EngineMode.SDK, forwardEngineEvent, {
    codexPath: codexPath(),
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
  });
  return engine;
}

/** Tear down the engine so the next session picks up new credentials. */
function resetEngine() {
  if (engine && typeof engine.disposeAll === 'function') {
    try {
      engine.disposeAll();
    } catch (err) {
      log.warn(`engine dispose failed: ${err.message}`);
    }
  }
  engine = null;
}

function prune(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));
}

function killAll(processes) {
  for (const proc of processes.values()) proc.kill();
  processes.clear();
}

/* ------------------------------------------------------------------ */
/* Workspace                                                          */
/* ------------------------------------------------------------------ */

ipcMain.handle('workspace:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开位置',
    defaultPath: os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/* ------------------------------------------------------------------ */
/* Settings (OpenAI-compatible base URL + API key)                   */
/* ------------------------------------------------------------------ */

ipcMain.handle('config:get', () => configStore.publicSettings());

ipcMain.handle('config:save', (_event, patch) => {
  try {
    configStore.saveSettings(patch || {});
    resetEngine();
    return { ok: true, settings: configStore.publicSettings() };
  } catch (err) {
    log.warn(`config:save rejected: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

/* ------------------------------------------------------------------ */
/* Engine                                                            */
/* ------------------------------------------------------------------ */

ipcMain.handle('engine:check', () => checkAgent(codexPath()));

ipcMain.handle('engine:start', async (_event, { sessionId, cfg = {} } = {}) => {
  const settings = configStore.loadSettings();
  const merged = prune({
    cwd: cfg.cwd,
    resumeThreadId: cfg.resumeThreadId,
    model: cfg.model || settings.model,
    approvalPolicy: cfg.approvalPolicy || settings.approvalPolicy,
    sandboxMode: cfg.sandboxMode || settings.sandboxMode,
  });
  try {
    return await getEngine().startSession(sessionId, merged);
  } catch (err) {
    log.error(`engine:start failed: ${err.message}`);
    forwardEngineEvent({ kind: 'error', sessionId, message: err.message });
    return { error: err.message };
  }
});

ipcMain.on('engine:prompt', (_event, { sessionId, text }) => {
  try {
    getEngine().sendPrompt(sessionId, text);
  } catch (err) {
    forwardEngineEvent({ kind: 'error', sessionId, message: err.message });
  }
});

ipcMain.on('engine:interrupt', (_event, { sessionId }) => {
  if (engine) engine.interrupt(sessionId);
});

ipcMain.on('engine:respond-approval', (_event, { requestId, decision }) => {
  if (engine) engine.respondApproval(requestId, decision);
});

/* ------------------------------------------------------------------ */
/* Terminal (real shell panel — unchanged pty path)                  */
/* ------------------------------------------------------------------ */

ipcMain.handle('terminal:create', async (_event, cwd) => {
  const id = String(nextTerminalId++);
  const shell = shellForPlatform();
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 24,
    cwd: cwd || os.homedir(),
    env: process.env,
  });

  terminals.set(id, term);
  term.onData((data) => sendToWindow('terminal:data', { id, data }));
  term.onExit(({ exitCode }) => {
    terminals.delete(id);
    sendToWindow('terminal:exit', { id, exitCode });
  });

  return { id, shell: path.basename(shell) };
});

ipcMain.on('terminal:write', (_event, { id, data }) => {
  const term = terminals.get(id);
  if (term) term.write(data);
});

ipcMain.on('terminal:resize', (_event, { id, cols, rows }) => {
  const term = terminals.get(id);
  if (term) term.resize(cols, rows);
});

ipcMain.on('terminal:dispose', (_event, id) => {
  const term = terminals.get(id);
  if (!term) return;
  term.kill();
  terminals.delete(id);
});

/* ------------------------------------------------------------------ */
/* App lifecycle                                                     */
/* ------------------------------------------------------------------ */

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  killAll(terminals);
  resetEngine();
  if (!isMac) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
