// src/core/ipc.js — the only contract between UI and backend.
export const CHANNELS = {
  state: 'turnoff:state', // main -> renderer, full state snapshot
  event: 'turnoff:event', // main -> renderer, discrete events (warning-played, shutdown-result…)
  start: 'turnoff:start',
  adjust: 'turnoff:adjust',
  pause: 'turnoff:pause',
  resume: 'turnoff:resume',
  cancel: 'turnoff:cancel',
  previewWarning: 'turnoff:preview-warning',
  meterState: 'turnoff:meter-state',
  getConfig: 'turnoff:get-config',
  setConfig: 'turnoff:set-config',
  quit: 'turnoff:quit',
  minimize: 'turnoff:minimize',
  hide: 'turnoff:hide',
  source: 'turnoff:source',
};
