// src/core/timer.js — shutdown countdown, no UI dependency.
// Time is injected so it can be tested without waiting.

export const MIN_LEAD_MS = 15_000;

// The v1 app pulled the trigger a minute after the countdown hit zero, and that
// margin is what kept a slow shutdown from being a surprise. Keep it.
export const FIRE_GRACE_MS = 60_000;

export class ShutdownTimer {
  /**
   * @param {object} opts
   * @param {() => number} [opts.now]
   * @param {(ms: number) => '*'} [opts.onChange] called with remaining ms
   * @param {(kind: string, data?: object) => void} [opts.onEvent]
   * @param {number} [opts.defaultMinutes]
   */
  constructor({ now = () => Date.now(), onChange = () => {}, onEvent = () => {}, defaultMinutes = 30, warnLeadMs = 5 * 60_000, fireGraceMs = FIRE_GRACE_MS } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.onEvent = onEvent;
    this.warnLeadMs = warnLeadMs;
    this.fireGraceMs = fireGraceMs;
    this.firedAt = null;
    this.shutdownAt = null;
    this.defaultMinutes = defaultMinutes;
    this.deadline = null;
    this.pausedLeft = null;
    this.warnedAt = null;
    this.fired = false;
    this._tick = this._tick.bind(this);
    this._handle = null;
  }

  get running() { return this.deadline !== null && this.pausedLeft === null; }
  get paused() { return this.pausedLeft !== null; }
  get armed() { return this.deadline !== null || this.pausedLeft !== null || this.fired; }

  remaining() {
    if (this.pausedLeft !== null) return Math.max(0, this.pausedLeft);
    if (this.fired && this.shutdownAt !== null) return Math.max(0, this.shutdownAt - this.now());
    if (this.deadline === null) return null;
    return Math.max(0, this.deadline - this.now());
  }

  /** Start (or restart) the countdown in minutes from now. */
  start(minutes = this.defaultMinutes) {
    this.deadline = this.now() + Math.max(0, minutes) * 60_000;
    this.pausedLeft = null;
    this.warnedAt = null;
    this.fired = false;
    this.firedAt = null;
    this.shutdownAt = null;
    this._ensureTicking();
    this.onEvent('armed', { remaining: this.remaining() });
    this._tick();
  }

  /** Accepts any signed minute delta. Never silently goes below the warning lead. */
  adjust(minutes) {
    if (!this.armed) return this.start(Math.max(0, minutes));
    const left = this.remaining();
    const next = left + minutes * 60_000;
    if (this.armed && next < MIN_LEAD_MS) {
      this.cancel('adjusted-below-lead');
      return 'below-lead';
    }
    if (this.pausedLeft !== null) {
      this.pausedLeft = next;
    } else {
      this.deadline = this.now() + next;
    }
    this.warnedAt = null;
    this.onChange(this.remaining());
    return 'ok';
  }

  pause() {
    // During the grace minute there is no deadline to freeze: just stand down
    // and let the deadline be pushed back explicitly.
    if (this.fired) {
      this.fired = false;
      this.firedAt = null;
      this.shutdownAt = null;
      this.deadline = null;
      this.pausedLeft = this.fireGraceMs; // resume gives back the last minute
      this.onEvent('paused');
      this.onChange(this.remaining());
      return true;
    }
    if (!this.running) return false;
    this.pausedLeft = this.remaining();
    this.deadline = null;
    this.onEvent('paused');
    this.onChange(this.remaining());
    return true;
  }

  resume() {
    if (this.pausedLeft === null) return false;
    this.deadline = this.now() + this.pausedLeft;
    this.pausedLeft = null;
    this.onEvent('resumed');
    this._ensureTicking();
    this.onChange(this.remaining());
    return true;
  }

  cancel(reason = 'user') {
    const wasArmed = this.armed;
    this.deadline = null;
    this.pausedLeft = null;
    this.warnedAt = null;
    this.fired = false;
    this.firedAt = null;
    this.shutdownAt = null;
    this.onChange(null);
    if (wasArmed) this.onEvent('disarmed', { reason });
    return wasArmed;
  }

  _ensureTicking() {
    if (this._handle) return;
    this._handle = setInterval(this._tick, 500);
    if (typeof this._handle.unref === 'function') this._handle.unref();
  }

  _tick() {
    if (!this.armed) {
      clearInterval(this._handle);
      this._handle = null;
      return;
    }
    const left = this.remaining();
    this.onChange(left);

    if (this.pausedLeft !== null) return;

    if (left <= this.warnLeadMs && this.warnedAt === null) {
      this.warnedAt = this.warnLeadMs;
      this.onEvent('warning', { remaining: left });
    }
    // At zero the countdown is over, but the shutdown waits one more minute:
    // same margin the v1 app had, and the last chance to change your mind.
    if (left <= 0 && !this.fired) {
      const endedAt = this.now();
      this.fired = true;
      this.firedAt = endedAt;
      this.shutdownAt = endedAt + this.fireGraceMs;
      // Keep it armed: the grace minute is still part of the countdown. The
      // deadline must NOT be "now", or every later tick thinks zero just
      // arrived and the grace clock keeps resetting.
      this.deadline = endedAt + this.fireGraceMs;
      this.onEvent('countdown-ended', { remaining: 0 });
    }
    if (this.fired && this.shutdownAt !== null && this.now() >= this.shutdownAt) {
      // The shutdown happened: the countdown is over, not paused.
      this.fired = false;
      this.firedAt = null;
      this.deadline = null;
      this.pausedLeft = null;
      clearInterval(this._handle);
      this._handle = null;
      this.onEvent('shutdown', { reason: 'countdown' });
    }
  }

  dispose() {
    if (this._handle) clearInterval(this._handle);
    this._handle = null;
  }
}

/** Format ms as mm:ss (or h:mm:ss above an hour). */
export function formatRemaining(ms) {
  if (ms === null || ms === undefined) return '--:--';
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
