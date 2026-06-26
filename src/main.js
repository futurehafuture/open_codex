const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const pty = require('node-pty');

const isMac = process.platform === 'darwin';
let mainWindow;
let terminals = new Map();
let agentSessions = new Map();
let nextTerminalId = 1;
let nextAgentId = 1;

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

function localBin(name) {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return path.join(app.getAppPath(), 'node_modules', '.bin', `${name}${suffix}`);
}

function resolveCodexCommand() {
  const configured = process.env.OPEN_CODEX_CLI;
  if (configured) return configured;

  const bundled = localBin('codex');
  if (fs.existsSync(bundled)) return bundled;

  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

function sendToWindow(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function killAll(processes) {
  for (const proc of processes.values()) proc.kill();
  processes.clear();
}

ipcMain.handle('workspace:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开位置',
    defaultPath: os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('agent:start', async (_event, options = {}) => {
  const id = String(nextAgentId++);
  const cwd = options.cwd || os.homedir();
  const command = resolveCodexCommand();
  const args = [];

  if (options.model) args.push('--model', options.model);
  if (options.approvalMode) args.push('--ask-for-approval', options.approvalMode);
  if (options.sandboxMode) args.push('--sandbox', options.sandboxMode);

  const agent = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: options.cols || 120,
    rows: options.rows || 32,
    cwd,
    env: { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' },
  });

  agentSessions.set(id, agent);
  agent.onData((data) => sendToWindow('agent:data', { id, data }));
  agent.onExit(({ exitCode }) => {
    agentSessions.delete(id);
    sendToWindow('agent:exit', { id, exitCode });
  });

  return { id, command: path.basename(command), cwd };
});

ipcMain.handle('agent:check', async () => new Promise((resolve) => {
  const command = resolveCodexCommand();
  const child = spawn(command, ['--version'], { shell: process.platform === 'win32' });
  let output = '';

  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.on('error', (error) => resolve({ available: false, command, error: error.message }));
  child.on('close', (code) => resolve({ available: code === 0, command, version: output.trim(), code }));
}));

ipcMain.on('agent:write', (_event, { id, data }) => {
  const agent = agentSessions.get(id);
  if (agent) agent.write(data);
});

ipcMain.on('agent:prompt', (_event, { id, prompt }) => {
  const agent = agentSessions.get(id);
  if (!agent) return;
  agent.write(prompt);
  agent.write('\r');
});

ipcMain.on('agent:resize', (_event, { id, cols, rows }) => {
  const agent = agentSessions.get(id);
  if (agent) agent.resize(cols, rows);
});

ipcMain.on('agent:dispose', (_event, id) => {
  const agent = agentSessions.get(id);
  if (!agent) return;
  agent.kill();
  agentSessions.delete(id);
});

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  killAll(terminals);
  killAll(agentSessions);
  if (!isMac) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
