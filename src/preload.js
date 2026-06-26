const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openCodex', {
  // Workspace -----------------------------------------------------------
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),

  // Settings (OpenAI-compatible base URL + key) -------------------------
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),

  // Engine --------------------------------------------------------------
  checkEngine: () => ipcRenderer.invoke('engine:check'),
  startEngine: (sessionId, cfg) => ipcRenderer.invoke('engine:start', { sessionId, cfg }),
  sendPrompt: (sessionId, text) => ipcRenderer.send('engine:prompt', { sessionId, text }),
  interrupt: (sessionId) => ipcRenderer.send('engine:interrupt', { sessionId }),
  respondApproval: (requestId, decision) =>
    ipcRenderer.send('engine:respond-approval', { requestId, decision }),
  onEngineEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('engine:event', listener);
    return () => ipcRenderer.removeListener('engine:event', listener);
  },

  // Store (projects / threads / messages) -------------------------------
  store: {
    listProjects: () => ipcRenderer.invoke('store:listProjects'),
    listThreads: (projectId) => ipcRenderer.invoke('store:listThreads', projectId),
    listMessages: (threadId) => ipcRenderer.invoke('store:listMessages', threadId),
  },

  // Terminal ------------------------------------------------------------
  createTerminal: (cwd) => ipcRenderer.invoke('terminal:create', cwd),
  writeTerminal: (id, data) => ipcRenderer.send('terminal:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  disposeTerminal: (id) => ipcRenderer.send('terminal:dispose', id),
  onTerminalData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
});
