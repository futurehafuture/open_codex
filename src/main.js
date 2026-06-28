'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

const { createEngine, resolveCodexCommand, checkAgent, EngineMode } = require('./main/engine');
const configStore = require('./main/config/store');
const store = require('./main/store/repositories');
const { createLogger } = require('./main/util/logger');

const log = createLogger('main');
const isMac = process.platform === 'darwin';

let mainWindow = null;
/** Lazily-built engine adapter; rebuilt whenever settings change. */
let engine = null;
/** local sessionId -> persistence mapping {projectId, dbThreadId, titled, engineThreadId} */
const sessions = new Map();
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

/** Forward every normalized engine event to the renderer, persisting along the way. */
function forwardEngineEvent(event) {
  persistEvent(event);
  sendToWindow('engine:event', event);
}

/** Persist the engine thread id + completed items. Never throws into the event path. */
function persistEvent(event) {
  const m = event.sessionId ? sessions.get(event.sessionId) : null;
  if (!m || !m.dbThreadId) return;
  try {
    if (event.kind === 'thread_started' && event.threadId && !m.engineThreadId) {
      store.setThreadEngineId(m.dbThreadId, event.threadId);
      m.engineThreadId = event.threadId;
    } else if (event.kind === 'item' && event.phase === 'completed' && event.item && isPersistableItem(event.item)) {
      store.appendItem(m.dbThreadId, event.item);
      store.touchThread(m.dbThreadId);
    }
  } catch (err) {
    log.warn(`persist event failed: ${err.message}`);
  }
}

/**
 * Whether a completed item is worth persisting. Skips empty text-only items
 * (usage placeholders, answers that streamed nothing) so replay stays clean.
 */
function isPersistableItem(item) {
  if (!item) return false;
  if (item.type === 'agent_message' || item.type === 'reasoning') {
    return Boolean(item.text && String(item.text).trim());
  }
  return true;
}

/** Save a user prompt, creating the thread row lazily on first send. */
function persistUserMessage(sessionId, text) {
  const m = sessions.get(sessionId);
  if (!m || !m.projectId) return;
  try {
    if (!m.dbThreadId) {
      const thread = store.createThread(m.projectId);
      m.dbThreadId = thread ? thread.id : null;
    }
    if (!m.dbThreadId) return;
    store.appendUserMessage(m.dbThreadId, text);
    if (!m.titled) {
      store.setThreadTitle(m.dbThreadId, deriveTitle(text));
      m.titled = true;
    }
    store.touchThread(m.dbThreadId);
  } catch (err) {
    log.warn(`persist user message failed: ${err.message}`);
  }
}

/** Reconstruct basic turn history from stored messages for agent resume. */
function buildHistory(messages) {
  if (!messages || messages.length === 0) return [];
  const history = [];
  for (const msg of messages) {
    try {
      const data = JSON.parse(msg.data);
      if (msg.role === 'user') {
        history.push({ role: 'user', content: data.text || '' });
      } else if (data.type === 'agent_message' && data.text && data.text.trim()) {
        history.push({ role: 'assistant', content: data.text });
      }
    } catch (_) { /* skip unparseable */ }
  }
  return history;
}

function deriveTitle(text) {
  const line = (text || '').split('\n')[0].trim();
  if (!line) return '新对话';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
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
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    approvalPolicy: cfg.approvalPolicy || settings.approvalPolicy,
    sandboxMode: cfg.sandboxMode || settings.sandboxMode,
  });
  // When resuming a thread, rebuild the conversation history from stored
  // messages so the agent remembers previous turns.
  if (cfg.resumeThreadId) {
    const thread = store.getThreadByEngineId(cfg.resumeThreadId);
    merged.history = thread ? buildHistory(store.listMessages(thread.id)) : [];
  }
  registerSession(sessionId, cfg);
  try {
    return await getEngine().startSession(sessionId, merged);
  } catch (err) {
    log.error(`engine:start failed: ${err.message}`);
    forwardEngineEvent({ kind: 'error', sessionId, message: err.message });
    return { error: err.message };
  }
});

/** Build the persistence mapping for a session (the thread row stays lazy). */
function registerSession(sessionId, cfg) {
  try {
    const project = store.ensureProject(cfg.cwd || os.homedir());
    let dbThreadId = null;
    let titled = false;
    let engineThreadId = null;
    if (cfg.resumeThreadId) {
      const thread = store.getThreadByEngineId(cfg.resumeThreadId);
      if (thread) {
        dbThreadId = thread.id;
        titled = Boolean(thread.title);
      }
      engineThreadId = cfg.resumeThreadId;
    }
    sessions.set(sessionId, { projectId: project ? project.id : null, dbThreadId, titled, engineThreadId });
  } catch (err) {
    log.warn(`registerSession failed: ${err.message}`);
    sessions.set(sessionId, { projectId: null, dbThreadId: null, titled: false, engineThreadId: null });
  }
}

ipcMain.on('engine:prompt', (_event, { sessionId, text }) => {
  persistUserMessage(sessionId, text);
  try {
    getEngine().sendPrompt(sessionId, text);
  } catch (err) {
    forwardEngineEvent({ kind: 'error', sessionId, message: err.message });
  }
});

ipcMain.on('engine:interrupt', (_event, { sessionId }) => {
  if (engine) engine.interrupt(sessionId);
  forwardEngineEvent({ kind: 'turn_interrupted', sessionId });
});

ipcMain.on('engine:dispose', (_event, { sessionId }) => {
  if (engine) engine.dispose(sessionId);
  sessions.delete(sessionId);
});

ipcMain.on('engine:respond-approval', (_event, { requestId, decision }) => {
  if (engine) engine.respondApproval(requestId, decision);
});

/* ------------------------------------------------------------------ */
/* Store (projects / threads / messages)                             */
/* ------------------------------------------------------------------ */

ipcMain.handle('store:listProjects', () => store.listProjects());
ipcMain.handle('store:listThreads', (_event, projectId) => store.listThreads(projectId));
ipcMain.handle('store:listMessages', (_event, threadId) => store.listMessages(threadId));
ipcMain.handle('store:deleteThread', (_event, threadId) => store.deleteThread(threadId));

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
  sessions.clear();
  store.close();
  if (!isMac) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
