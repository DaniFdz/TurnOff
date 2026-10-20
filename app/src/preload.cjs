// src/preload.cjs — the only bridge between the sandboxed UI and the core.
const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  state: 'turnoff:state',
  event: 'turnoff:event',
  start: 'turnoff:start',
  adjust: 'turnoff:adjust',
  pause: 'turnoff:pause',
  resume: 'turnoff:resume',
  cancel: 'turnoff:cancel',
  previewWarning: 'turnoff:preview-warning',
  meterState: 'turnoff:meter-state',
  getConfig: 'turnoff:get-config',
  setConfig: 'turnoff:set-config',
};

const subscribe = (channel, cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('turnoff', {
  start: (minutes) => ipcRenderer.invoke(CH.start, minutes),
  adjust: (minutes) => ipcRenderer.invoke(CH.adjust, minutes),
  pause: () => ipcRenderer.invoke(CH.pause),
  resume: () => ipcRenderer.invoke(CH.resume),
  cancel: () => ipcRenderer.invoke(CH.cancel),
  previewWarning: () => ipcRenderer.invoke(CH.previewWarning),
  getMeterState: () => ipcRenderer.invoke(CH.meterState),
  getConfig: () => ipcRenderer.invoke(CH.getConfig),
  setConfig: (patch) => ipcRenderer.invoke(CH.setConfig, patch),
  openLink: (url) => ipcRenderer.invoke('turnoff:open-link', url),
  onState: (cb) => subscribe(CH.state, cb),
  onEvent: (cb) => subscribe(CH.event, cb),
});
