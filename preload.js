const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  launchGame: () => ipcRenderer.send('launchGame'),
  closeGame: () => ipcRenderer.send('closeGame'),
  createServerWithPort: (port) => ipcRenderer.invoke('createWsServer', port),
  stopWsServer: () => ipcRenderer.invoke('stopWsServer'),
  connectWithUrl: (url) => ipcRenderer.invoke('connectWithUrl', url),
  disconnectFromServer: () => ipcRenderer.invoke('disconnect'),
  getConnectionStatus: () => ipcRenderer.invoke('getConnectionStatus'),
  autoConnect: (targetUrl, port) => ipcRenderer.invoke('autoConnect', targetUrl, port),
});
