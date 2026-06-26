const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openCodex', {
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  checkAgent: () => ipcRenderer.invoke('agent:check'),
  startAgent: (options) => ipcRenderer.invoke('agent:start', options),
  writeAgent: (id, data) => ipcRenderer.send('agent:write', { id, data }),
  sendAgentPrompt: (id, prompt) => ipcRenderer.send('agent:prompt', { id, prompt }),
  resizeAgent: (id, cols, rows) => ipcRenderer.send('agent:resize', { id, cols, rows }),
  disposeAgent: (id) => ipcRenderer.send('agent:dispose', id),
  onAgentData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:data', listener);
    return () => ipcRenderer.removeListener('agent:data', listener);
  },
  onAgentExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:exit', listener);
    return () => ipcRenderer.removeListener('agent:exit', listener);
  },
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
