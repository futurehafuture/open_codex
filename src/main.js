const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

const isMac = process.platform === 'darwin';
let mainWindow;
let terminals = new Map();
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
  term.onData((data) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('terminal:data', { id, data });
  });
  term.onExit(({ exitCode }) => {
    terminals.delete(id);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('terminal:exit', { id, exitCode });
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
  for (const term of terminals.values()) term.kill();
  terminals.clear();
  if (!isMac) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
