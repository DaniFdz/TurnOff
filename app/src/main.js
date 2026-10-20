// src/main.js — electron main process: window, tray, and the wiring between UI and core.

import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';

import { NightSession } from './core/session.js';
import { createPower } from './core/power.js';
import { LevelSensor } from './core/audio.js';
import { Meter, defaultBackend } from './core/meter.js';
import { Leveler } from './core/dynamics.js';
import { VoiceWarning } from './core/warning.js';
import { loadConfig, saveConfig, configPath, DEFAULTS } from './core/config.js';
import { CHANNELS } from './core/ipc.js';
import { formatRemaining } from './core/timer.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(ROOT, '..', 'assets');
const PRELOAD = join(ROOT, 'preload.cjs');

// Electron needs the app name before `app.whenReady` to use the right userData dir.
app.setName('TurnOff');

// A tray app that dies silently is unrecoverable; keep a small boot log next to
// the settings so a failed start can be explained after the fact.
function bootLog(message) {
  try {
    const file = join(app.getPath('userData'), 'boot.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never be the reason the app fails to start.
  }
}
if (process.platform === 'win32') app.setAppUserModelId('com.danifdz.turnoff');

let win = null;
let tray = null;
let config = { ...DEFAULTS };
let session = null;
let quitting = false;

function resolveAsset(name) {
  const candidates = [
    join(ASSET_DIR, name),
    join(ASSET_DIR, 'voice', name),
    join(ROOT, '..', 'dist', 'assets', name),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ---------------------------------------------------------------- audio
//
// The warning is played by an invisible BrowserWindow with an <audio> element.
// We used to shell out to mpv, which is not installed on a normal Windows box:
// the warning silently did nothing. This path needs no external player, has a
// real volume control and a real finish event.

const AUDIO_PRELOAD = join(ROOT, 'audio-preload.cjs');
const AUDIO_PAGE = join(ROOT, 'audio-window', 'index.html');
let audioWin = null;
let audioJob = null;

function getAudioWindow() {
  if (audioWin && !audioWin.isDestroyed()) return audioWin;
  audioWin = new BrowserWindow({
    width: 320,
    height: 180,
    show: false,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    backgroundColor: '#0c0d12',
    webPreferences: {
      preload: AUDIO_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  audioWin.loadFile(AUDIO_PAGE);
  audioWin.on('closed', () => (audioWin = null));
  return audioWin;
}

function resolveClipPath(name) {
  for (const dir of [join(ASSET_DIR, 'voice'), ASSET_DIR]) {
    for (const candidate of [name, `${name}.mp3`, `${name}.wav`, `${name}.ogg`]) {
      const p = join(dir, candidate);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function playFile(path, gain) {
  return new Promise((resolve, reject) => {
    const filePath = resolveClipPath(path) ?? (existsSync(path) ? path : null);
    if (!filePath) return reject(new Error(`clip not found: ${path}`));

    const win = getAudioWindow();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      audioJob = null;
      clearTimeout(audioJob?.timer);
      err ? reject(err) : resolve();
      if (win && !win.isDestroyed()) win.hide();
    };

    audioJob = { win, finish };
    // A short clip cannot take long; a stuck overlay must never block shutdown.
    const timer = setTimeout(() => finish(new Error('playback timeout')), 30_000);
    audioJob.timer = timer;

    const send = () =>
      win.webContents.send('turnoff:audio:play', { path: filePath, gain, label: `Warning · ${Math.round(gain * 100)}%` });
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  });
}

ipcMain.on('turnoff:audio:event', (_event, { type, data }) => {
  if (!audioJob) return;
  if (type === 'playing') {
    bootLog(`warning playing at volume ${data?.volume}`);
    return;
  }
  if (type === 'ended') audioJob.finish();
  else if (type === 'error') audioJob.finish(new Error(data?.message ?? 'audio error'));
});

function buildSession() {
  const power = createPower({ dryRun: config.dryRun });
  const sensor = new LevelSensor();
  const meter = new Meter({ read: defaultBackend() });
  sensor.attachMeter(meter);
  const leveler = new Leveler({ ceilingDb: config.levelingCeiling });
  if (config.leveling) meter.start();
  const warning = new VoiceWarning({
    playFile,
    resolveClip: resolveAsset,
    sensor,
    bump: config.voiceBumpPercent,
    log: (m) => console.warn('[turnoff]', m),
  });

  const s = new NightSession({
    shutdown: () => power.shutdown(),
    warn: () => warning.play(config.warnLeadMinutes).then(() => {}),
    warnLeadMs: config.warnLeadMinutes * 60_000,
    onState: (state) => {
      win?.webContents.send(CHANNELS.state, { ...state, meter: meter.snapshot(), leveling: config.leveling });
      updateTray(state);
    },
    onEvent: (kind, data) => {
      win?.webContents.send(CHANNELS.event, { kind, data });
      if (kind === 'warning') showWindow();
      if (kind === 'warning-failed') console.warn('[turnoff] warning failed', data);
    },
  });
  return { session: s, sensor, warning, power, meter, leveler };
}

function initSession() {
  const built = buildSession();
  session = built.session;
  session.startRef = built;
  return built;
}

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 640,
    minWidth: 720,
    minHeight: 560,
    frame: false,
    show: !config.startMinimized,
    backgroundColor: '#0c0d12',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(join(ROOT, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => (win = null));
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  return win;
}

function windowState() {
  if (!win || win.isDestroyed()) return { minimized: false, visible: false };
  return { minimized: win.isMinimized(), visible: win.isVisible() };
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------- tray

function updateTray(state) {
  if (!tray) return;
  const label = state?.armed ? formatRemaining(state.remaining) : 'TurnOff';
  tray.setToolTip(state?.armed ? `TurnOff — ${label}` : 'TurnOff');
  const menu = Menu.buildFromTemplate([
    { label: state?.armed ? `Shutting down in ${label}` : 'No countdown', enabled: false },
    { type: 'separator' },
    { label: 'Open TurnOff', click: showWindow },
    { label: '+15 minutes', click: () => session.adjust(15) },
    { label: state?.paused ? 'Resume' : 'Pause', enabled: Boolean(state?.armed), click: () => (state?.paused ? session.resume() : session.pause()) },
    { label: 'Cancel', enabled: Boolean(state?.armed), click: () => session.cancel('tray') },
    { type: 'separator' },
    { label: 'Quit TurnOff', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setTitle?.(state?.armed ? label : '');
}

function createTray() {
  const iconPath = resolveAsset('tray.png') ?? resolveAsset('icon.png');
  const image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.on('click', showWindow);
  updateTray(session?.state ?? {});
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle(CHANNELS.start, (_e, minutes) => session.start(minutes ?? config.defaultMinutes));
  ipcMain.handle(CHANNELS.adjust, (_e, minutes) => session.adjust(minutes));
  ipcMain.handle(CHANNELS.pause, () => session.pause());
  ipcMain.handle(CHANNELS.resume, () => session.resume());
  ipcMain.handle(CHANNELS.cancel, () => session.cancel('ui'));
  ipcMain.handle(CHANNELS.previewWarning, async () => {
    const { warning } = session.startRef;
    try {
      return await warning.play(config.warnLeadMinutes);
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err) };
    }
  });
  ipcMain.handle(CHANNELS.previewChime, async () => {
    const { warning } = session.startRef;
    const restore = warning.kind;
    warning.kind = 'chime';
    try {
      return await warning.play(config.warnLeadMinutes);
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err) };
    } finally {
      warning.kind = restore;
    }
  });
  ipcMain.handle(CHANNELS.getConfig, () => config);
  ipcMain.handle(CHANNELS.setConfig, async (_e, patch) => {
    const previous = config;
    config = await saveConfig({ ...config, ...patch });
    const built = initSession();
    if (config.leveling && !previous.leveling) built.meter.start();
    if (!config.leveling && previous.leveling) built.meter.stop();
    // Push the new shape immediately; waiting for the next tick hides the
    // change until the countdown moves.
    built.session._emit();
    return config;
  });
  ipcMain.handle(CHANNELS.meterState, () => session.startRef.meter.snapshot());
  ipcMain.handle(CHANNELS.minimize, () => {
    if (!win || win.isDestroyed()) return false;
    // Minimize to the tray, not to the taskbar: this is a tray app.
    win.minimize();
    return true;
  });
  ipcMain.handle(CHANNELS.hide, () => {
    if (!win || win.isDestroyed()) return false;
    win.hide();
    return true;
  });
  ipcMain.handle(CHANNELS.quit, () => {
    quitting = true;
    app.quit();
    return true;
  });
  ipcMain.handle(CHANNELS.source, () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    userData: app.getPath('userData'),
    config: configPath(),
  }));
  ipcMain.handle('turnoff:open-link', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
  });
}

// ---------------------------------------------------------------- boot

app.whenReady().then(async () => {
  bootLog('boot, userData=' + app.getPath('userData'));
  config = await loadConfig();
  // Persist on first run: a missing settings.json means the user never sees
  // the defaults the app is actually running with.
  config = await saveConfig(config);
  bootLog('config loaded');
  initSession();
  registerIpc();
  createWindow();
  bootLog('window created');
  try {
    createTray();
    bootLog('tray created');
  } catch (err) {
    bootLog('tray failed: ' + (err?.stack ?? err));
  }

  if (process.platform === 'linux') app.dock?.hide?.();
});

app.on('window-all-closed', () => {
  // Tray app: closing the window is not quitting.
});

app.on('before-quit', () => { quitting = true; });

app.on('second-instance', () => showWindow());

if (!app.requestSingleInstanceLock()) app.quit();
