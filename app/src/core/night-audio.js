// src/core/night-audio.js — talks to the Windows night-mode helper (NightAudio.cs).
//
// The helper does the fast part (reads the playback peak and rides the master
// volume ~60 times a second). This module starts it, keeps it alive, tells it
// what to do, and keeps the latest reading for the UI and the voice warning.

export const LEVELER_DEFAULTS = Object.freeze({
  ceilingDb: -18, // peaks above this (dBFS, before the volume slider) get cut
  attackMs: 5, // the cut is practically instant: a gunshot must not get through
  releaseMs: 1500, // come back slowly so speech does not pump
  holdMs: 400, // stay down between shots of the same burst
  maxCutDb: 24, // never more than this below the user's volume
});

const toDb = (a) => (typeof a === 'number' && a > 0 ? 20 * Math.log10(a) : null);

export class NightAudio {
  /**
   * @param {object} deps
   * @param {() => import('node:child_process').ChildProcess} deps.spawn starts the helper
   * @param {(msg: string) => void} [deps.log]
   * @param {number} [deps.restartDelayMs]
   * @param {number} [deps.maxRestarts] within restartWindowMs
   * @param {() => number} [deps.now]
   */
  constructor({ spawn, log = () => {}, restartDelayMs = 2000, maxRestarts = 5, restartWindowMs = 5 * 60_000, now = () => Date.now() }) {
    this.spawnFn = spawn;
    this.log = log;
    this.restartDelayMs = restartDelayMs;
    this.maxRestarts = maxRestarts;
    this.restartWindowMs = restartWindowMs;
    this.now = now;
    this.child = null;
    this.ready = false;
    this.available = false;
    this.reason = 'starting';
    this.level = null;
    this.desired = null;
    this.stopping = false;
    this.restarts = [];
    this.listeners = new Set();
    this.buffer = '';
  }

  start() {
    this.stopping = false;
    if (!this.child) this._spawn();
  }

  /** Mark the helper as unusable (e.g. it could not be built) with a reason the UI shows. */
  fail(reason) {
    this.available = false;
    this.ready = false;
    this.reason = reason;
    this._notify();
  }

  /** Turn leveling on (with options) or off. Remembered across helper restarts. */
  setEnabled(on, opts = {}) {
    if (on) {
      const clean = {};
      for (const [k, v] of Object.entries(opts)) if (k in LEVELER_DEFAULTS && Number.isFinite(Number(v))) clean[k] = Number(v);
      this.desired = { ...LEVELER_DEFAULTS, ...clean };
    } else {
      this.desired = null;
    }
    if (this.ready) this._send(this.command());
  }

  command() {
    if (!this.desired) return 'off';
    const d = this.desired;
    return ['on', d.ceilingDb, d.attackMs, d.releaseMs, d.holdMs, d.maxCutDb].join(' ');
  }

  /** Give the volume back and end the helper. */
  stop() {
    this.stopping = true;
    this._send('quit');
    const child = this.child;
    const t = setTimeout(() => { try { child?.kill(); } catch { /* already gone */ } }, 1500);
    t.unref?.();
  }

  onLevel(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot() {
    const l = this.level;
    const peak = this.available && l ? l.peak : null;
    return {
      available: this.available,
      reason: this.available ? null : this.reason,
      peak,
      peakDb: toDb(peak),
      gainDb: this.available && l && l.on ? l.gainDb : null,
      volumeDb: l ? l.volumeDb : null,
      leveling: Boolean(l && l.on),
    };
  }

  // ---------------------------------------------------------------- internals

  _spawn() {
    let child;
    try {
      child = this.spawnFn();
    } catch (err) {
      this.fail('helper-spawn-failed');
      this.log('spawn failed: ' + (err?.message ?? err));
      return;
    }
    this.child = child;
    this.buffer = '';
    this.ready = false;
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => this._onData(String(chunk)));
    child.stderr?.on('data', (chunk) => this.log('helper stderr: ' + String(chunk).slice(0, 300)));
    child.on?.('error', (err) => this.log('helper error: ' + (err?.message ?? err)));
    child.on?.('exit', (code) => this._onExit(code));
  }

  _onExit(code) {
    this.child = null;
    this.ready = false;
    this.available = false;
    this.level = null;
    this.reason = 'helper-exited';
    this.log('helper exited with ' + code);
    this._notify();
    if (this.stopping) return;
    const now = this.now();
    this.restarts = this.restarts.filter((t) => now - t < this.restartWindowMs);
    if (this.restarts.length >= this.maxRestarts) {
      this.reason = 'helper-crashed';
      this._notify();
      return;
    }
    this.restarts.push(now);
    const t = setTimeout(() => { if (!this.stopping && !this.child) this._spawn(); }, this.restartDelayMs);
    t.unref?.();
  }

  _onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      this.log('helper said: ' + line.slice(0, 200));
      return;
    }
    switch (m.t) {
      case 'ready':
        this.ready = true;
        this.reason = null;
        // A restarted helper starts "off": bring it back to what we want.
        if (this.desired) this._send(this.command());
        break;
      case 'level':
        this.available = Boolean(m.ok);
        this.reason = m.ok ? null : 'no-device';
        this.level = {
          peak: typeof m.peak === 'number' ? Math.min(1, Math.max(0, m.peak)) : 0,
          volumeDb: typeof m.vol === 'number' ? m.vol : null,
          gainDb: typeof m.gain === 'number' ? m.gain : 0,
          on: Boolean(m.on),
        };
        this._notify();
        break;
      case 'device':
        this.log('audio device ' + m.id);
        break;
      case 'state':
        this.log('leveler ' + (m.on ? 'on, ceiling ' + m.ceiling + ' dBFS' : 'off, volume restored'));
        break;
      case 'recovered':
        this.log('gave back volume left down by a previous run: ' + m.was + ' -> ' + m.base + ' dB');
        break;
      case 'orphaned':
        this.log('helper lost its parent');
        break;
      case 'error':
        this.log('helper error: ' + m.msg);
        break;
      default:
        break;
    }
  }

  _send(line) {
    try {
      this.child?.stdin?.write(line + '\n');
    } catch (err) {
      this.log('send failed: ' + (err?.message ?? err));
    }
  }

  _notify() {
    for (const fn of this.listeners) {
      try { fn(this.snapshot()); } catch { /* a listener must not break the helper */ }
    }
  }
}
