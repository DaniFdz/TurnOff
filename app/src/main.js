// src/main.js — electron main process: window, tray, and the wiring between UI and core.

import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { NightSession } from './core/session.js';
import { createPower } from './core/power.js';
import { LevelSensor } from './core/audio.js';
import { VoiceWarning } from './core/warning.js';
import { loadConfig, saveConfig, DEFAULTS } from './core/config.js';
import { CHANNELS } from './core/ipc.js';
import { formatRemaining } from './core/timer.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(ROOT, '..', 'assets');
const PRELOAD = join(ROOT, 'preload.cjs');

// Electron needs the app name before `app.whenReady` to use the right userData dir.
app.setName('TurnOff');
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

function playFile(path, gain) {
  return new Promise((resolve, reject) => {
    // `--gain` is applied as element volume, never as a system volume change.
    const child = spawn(
      process.env.TURNOFF_PLAYER || 'mpv',
      ['--no-video', '--really-quiet', '--volume=100', `--af=volume=${(gain * 100).toFixed(1)}dB`, path],
      { windowsHide: true, stdio: 'ignore' },
    );
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`player exit ${code}`))));
  });
}

function buildSession() {
  const power = createPower({ dryRun: config.dryRun });
  const sensor = new LevelSensor();
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
      win?.webContents.send(CHANNELS.state, state);
      updateTray(state);
    },
    onEvent: (kind, data) => {
      win?.webContents.send(CHANNELS.event, { kind, data });
      if (kind === 'warning') showWindow();
      if (kind === 'warning-failed') console.warn('[turnoff] warning failed', data);
    },
  });
  return { session: s, sensor, warning, power };
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
  win.on('closed', () => (win = null));
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  return win;
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
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
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
  ipcMain.handle(CHANNELS.getConfig, () => config);
  ipcMain.handle(CHANNELS.setConfig, async (_e, patch) => {
    config = await saveConfig({ ...config, ...patch });
    initSession();
    return config;
  });
  ipcMain.handle('turnoff:open-link', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
  });
}

// ---------------------------------------------------------------- boot

app.whenReady().then(async () => {
  config = await loadConfig();
  initSession();
  registerIpc();
  createWindow();
  createTray();

  if (process.platform === 'linux') app.dock?.hide?.();
});

app.on('window-all-closed', () => {
  // Tray app: closing the window is not quitting.
});

app.on('before-quit', () => { quitting = true; });

app.on('second-instance', () => showWindow());

if (!app.requestSingleInstanceLock()) app.quit();
