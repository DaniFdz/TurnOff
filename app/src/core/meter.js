// src/core/meter.js — an honest peak meter for the default output.
//
// It reports what it can actually measure. When no backend is available it
// says `available: false` instead of inventing numbers, and the UI shows that
// state. Backends:
//
//   - linux: `pactl`/`wpctl` peak via `pw-dump` is not exposed, so we read
//     `pactl subscribe`-free: sampled `pactl get-sink-volume` is master volume,
//     NOT the stream. We therefore only claim a meter where we have one.
//   - windows: Core Audio (`IAudioMeterInformation::GetPeakValue`). Not wired
//     yet: it needs a native addon, and shipping an unverified addon would be
//     worse than reporting "unavailable".

export class Meter {
  /**
   * @param {object} deps
   * @param {() => Promise<{ok:boolean, peak?:number, reason?:string}>} deps.read
   * @param {number} [deps.intervalMs]
   */
  constructor({ read, intervalMs = 250 } = {}) {
    this.readBackend = read ?? (async () => ({ ok: false, reason: 'no-backend' }));
    this.intervalMs = intervalMs;
    this.timer = null;
    this.available = null;
    this.reason = null;
    this.peak = null;
    this.listeners = new Set();
  }

  onSample(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._sample(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    await this._sample();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _sample() {
    try {
      const res = await this.readBackend();
      this.available = Boolean(res?.ok);
      this.reason = res?.ok ? null : (res?.reason ?? 'unknown');
      this.peak = res?.ok ? clamp(res.peak) : null;
    } catch (err) {
      this.available = false;
      this.reason = String(err?.message ?? err);
      this.peak = null;
    }
    for (const fn of this.listeners) fn(this.snapshot());
  }

  snapshot() {
    return { available: this.available, reason: this.reason, peak: this.peak };
  }
}

function clamp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Backend for Linux: reads the peak of the default *stream*, not the master
 * volume. `wpctl` does not expose a peak value, so we report unavailable and
 * say why, instead of pretending the master volume is the playback level.
 */
export function linuxBackend({ run } = {}) {
  return async () => {
    if (!run) return { ok: false, reason: 'linux-meter-not-implemented' };
    return { ok: false, reason: 'linux-meter-not-implemented' };
  };
}

/**
 * Backend for Windows. Until the native Core Audio addon exists, this reports
 * unavailable, and the app falls back to the last known warning gain.
 */
export function windowsBackend() {
  return async () => ({ ok: false, reason: 'core-audio-addon-missing' });
}

/** Pick the backend for this platform, or a stub that reports unavailable. */
export function defaultBackend(platform = process.platform) {
  if (platform === 'win32') return windowsBackend();
  if (platform === 'linux') return linuxBackend();
  return async () => ({ ok: false, reason: `unsupported-platform:${platform}` });
}
