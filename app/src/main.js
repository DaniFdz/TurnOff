// src/main.js — electron main process: window, tray, and the wiring between UI and core.

import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

import { NightSession } from './core/session.js';
import { createPower } from './core/power.js';
import { LevelSensor } from './core/audio.js';
import { Meter, defaultBackend } from './core/meter.js';
import { Leveler } from './core/dynamics.js';
import { NightAudio } from './core/night-audio.js';
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


// ---------------------------------------------------------------- night audio
//
// The Windows helper is C# compiled on first run with the csc.exe that ships
// with .NET Framework, so nothing has to be installed and the source stays
// readable in the repo. One exe per source hash: an update rebuilds it.

let nightAudio = null;

function compileNightAudio(dir) {
  const source = readFileSync(join(ROOT, 'night-audio', 'NightAudio.cs'));
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 10);
  const exe = join(dir, 'night-audio-' + hash + '.exe');
  if (existsSync(exe)) return Promise.resolve(exe);
  const cs = join(dir, 'NightAudio.cs');
  writeFileSync(cs, source);
  const win = process.env.WINDIR || 'C:\\Windows';
  const csc = [join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find((p) => existsSync(p));
  if (!csc) return Promise.reject(new Error('csc.exe not found'));
  return new Promise((resolve, reject) => {
    execFile(csc, ['/nologo', '/optimize+', '/target:exe', '/out:' + exe, cs], { windowsHide: true, timeout: 60_000 }, (err, stdout) => {
      if (err || !existsSync(exe)) reject(new Error(String(stdout || err?.message || 'compile failed').slice(0, 400)));
      else resolve(exe);
    });
  });
}

function startNightAudio() {
  if (process.platform !== 'win32') return null;
  const dir = join(app.getPath('userData'), 'night-audio');
  mkdirSync(dir, { recursive: true });
  let exePath = null;
  const na = new NightAudio({
    spawn: () => spawn(exePath, ['--state', join(dir, 'baseline.state'), '--parent', String(process.pid)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    log: (m) => bootLog('night-audio: ' + m),
  });
  compileNightAudio(dir)
    .then((exe) => {
      exePath = exe;
      bootLog('night-audio: helper ' + exe);
      na.start();
    })
    .catch((err) => {
      bootLog('night-audio: build failed: ' + err.message);
      na.fail('compile-failed');
    });
  return na;
}

function levelerOptions() {
  return { ceilingDb: config.levelingCeiling };
}

/** State for the renderer: session + live audio, without touching the tray. */
function pushState() {
  if (!win || win.isDestroyed() || !session) return;
  const audio = nightAudio ? nightAudio.snapshot() : { available: false, reason: 'unsupported-platform' };
  win.webContents.send(CHANNELS.state, {
    ...session.state,
    meter: { available: audio.available, reason: audio.reason, peak: audio.peak },
    peakDb: audio.peakDb,
    gainDb: audio.gainDb,
    leveling: config.leveling,
  });
}

function buildSession() {
  // Built ONCE. Settings changes update these objects in place: rebuilding the
  // session used to orphan a running countdown the moment a toggle was touched.
  const power = () => createPower({ dryRun: config.dryRun });
  const sensor = new LevelSensor();
  // The meter reads whatever the night-audio helper last measured; it feeds the
  // voice warning gain even when leveling is off.
  const meter = new Meter({
    read: nightAudio
      ? async () => {
          const a = nightAudio.snapshot();
          return a.available ? { ok: true, peak: a.peak } : { ok: false, reason: a.reason };
        }
      : defaultBackend(),
  });
  sensor.attachMeter(meter);
  const leveler = new Leveler({ ceilingDb: config.levelingCeiling });
  meter.start();
  nightAudio?.setEnabled(config.leveling, levelerOptions());
  const warning = new VoiceWarning({
    playFile,
    resolveClip: resolveAsset,
    sensor,
    bump: config.voiceBumpPercent,
    log: (m) => bootLog('warning: ' + m),
  });

  const s = new NightSession({
    shutdown: () => power().shutdown(),
    scheduler: {
      schedule: (seconds) => power().schedule(seconds),
      abort: () => power().abort(),
    },
    warn: () => warning.play(config.warnLeadMinutes).then((res) => {
      if (res && res.ok === false) throw new Error(res.reason ?? 'no audio');
    }),
    warnLeadMs: config.warnLeadMinutes * 60_000,
    onState: (state) => {
      pushState();
      updateTray(state);
    },
    onEvent: (kind, data) => {
      win?.webContents.send(CHANNELS.event, { kind, data });
      bootLog('event ' + kind + (data ? ' ' + JSON.stringify(data) : ''));
      if (kind === 'warning') showWindow();
      // Hand the volume back before Windows powers off, or the next boot starts quiet.
      if (kind === 'shutdown') nightAudio?.setEnabled(false);
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

/** Apply new settings to the live session without touching its countdown. */
function applyConfig(previous) {
  const { warning } = session.startRef;
  warning.bump = config.voiceBumpPercent;
  session.timer.warnLeadMs = config.warnLeadMinutes * 60_000;
  if (config.leveling !== previous.leveling || config.levelingCeiling !== previous.levelingCeiling) {
    nightAudio?.setEnabled(config.leveling, levelerOptions());
  }
  // Dry run toggled while armed: move the OS-side shutdown accordingly.
  if (previous.dryRun !== config.dryRun && session.timer.armed && !session.timer.paused) {
    if (config.dryRun) createPower({ dryRun: false }).abort();
    else session._sync();
  }
  session._emit();
}

/** Command-line control: TurnOff.exe --arm=30 | --cancel (also via a second instance). */
function handleArgs(argv) {
  for (const arg of argv) {
    const arm = /^--arm=(\d+(?:\.\d+)?)$/.exec(arg);
    if (arm) { bootLog('cli arm ' + arm[1]); session.start(Number(arm[1])); }
    if (arg === '--cancel') { bootLog('cli cancel'); session.cancel('cli'); }
  }
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
  // Windows is logging off or shutting down: give the volume back now.
  win.on('session-end', () => nightAudio?.setEnabled(false));
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
    bootLog('config ' + JSON.stringify(patch));
    applyConfig(previous);
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
  nightAudio = startNightAudio();
  initSession();
  // ~5 updates a second for the meter; the tray is only rebuilt on session changes.
  nightAudio?.onLevel(() => pushState());
  registerIpc();
  createWindow();
  bootLog('window created');
  try {
    createTray();
    bootLog('tray created');
  } catch (err) {
    bootLog('tray failed: ' + (err?.stack ?? err));
  }

  handleArgs(process.argv);
  if (process.platform === 'linux') app.dock?.hide?.();
});

app.on('window-all-closed', () => {
  // Tray app: closing the window is not quitting.
});

app.on('before-quit', () => {
  quitting = true;
  nightAudio?.stop();
});

app.on('second-instance', (_e, argv) => {
  if (argv.some((a) => a.startsWith('--arm=') || a === '--cancel')) handleArgs(argv);
  else showWindow();
});

if (!app.requestSingleInstanceLock()) app.quit();
