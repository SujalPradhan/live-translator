const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('geminiAudio', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings, key) => ipcRenderer.invoke('settings:save', settings, key),
  forgetKey: () => ipcRenderer.invoke('settings:forget'),
  checkAudioBackend: id => ipcRenderer.invoke('routing:probe', id),
  selectAudioBackend: id => ipcRenderer.invoke('routing:select', id),
  routingStatus: () => ipcRenderer.invoke('routing:status'),
  setupRouting: () => ipcRenderer.invoke('routing:setup'),
  removeRouting: () => ipcRenderer.invoke('routing:remove'),
  checkHealth: (kind, direction, patch, key) => ipcRenderer.invoke('health:check', kind, direction, patch, key),
  cancelHealthChecks: () => ipcRenderer.invoke('health:cancel'),
  openGuide: platform => ipcRenderer.invoke('guide:open', platform),
  onRoutingChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on('routing:changed', listener);
    return () => ipcRenderer.removeListener('routing:changed', listener);
  },
  startTranslation: (direction, id) => ipcRenderer.invoke('translation:start', direction, id),
  stopTranslation: (direction, id) => ipcRenderer.invoke('translation:stop', direction, id),
  sendAudio: (direction, id, pcm, at) => ipcRenderer.send('translation:pcm', direction, id, pcm, at),
  onTranslation: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('translation:event', listener);
    return () => ipcRenderer.removeListener('translation:event', listener);
  }
});
