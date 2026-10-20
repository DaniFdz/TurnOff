// audio-preload.cjs — minimal bridge for the playback window.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { readFileSync } = require('node:fs');
const { extname } = require('node:path');

const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };

let playHandler = () => {};
let closeHandler = () => {};

ipcRenderer.on('turnoff:audio:play', (_event, payload) => playHandler(payload));
ipcRenderer.on('turnoff:audio:close', () => closeHandler());

// Reads the clip here, in the privileged preload, and hands the page a Blob it
// can turn into an object URL. No file-system or node access in the renderer.
function readClip(path) {
  const data = readFileSync(path);
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  return { data: new Uint8Array(data), type };
}

contextBridge.exposeInMainWorld('turnoffAudio', {
  onPlay: (fn) => { playHandler = fn; },
  onClose: (fn) => { closeHandler = fn; },
  readClip,
  event: (type, data) => ipcRenderer.send('turnoff:audio:event', { type, data }),
});
