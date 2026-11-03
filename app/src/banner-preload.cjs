// banner-preload.cjs — the banner only needs text in and a dismiss out.
const { contextBridge, ipcRenderer } = require('electron');

let showHandler = () => {};

ipcRenderer.on('turnoff:banner:show', (_e, payload) => showHandler(payload));
ipcRenderer.on('turnoff:banner:close', () => window.close());

contextBridge.exposeInMainWorld('turnoffBanner', {
  onShow: (fn) => { showHandler = fn; },
  onClose: (fn) => { fn(); },
  dismiss: () => ipcRenderer.send('turnoff:banner:dismiss'),
});
