// src/core/session.js — deep module tying the countdown, the voice warning and the power call.
// The UI and the tray both talk to this and nothing else.

import { ShutdownTimer } from './timer.js';

export class NightSession {
  /**
   * @param {object} deps
   * @param {() => Promise<{ok:boolean, error?:string}>} deps.shutdown
   * @param {() => Promise<void>} deps.warn  plays the voice clip at adjusted volume
   * @param {() => number} [deps.now]
   * @param {(state: object) => void} [deps.onState]
   * @param {(event: string, data?: object) => void} [deps.onEvent]
   */
  constructor({ shutdown, warn, now, onState = () => {}, onEvent = () => {}, warnLeadMs = 5 * 60_000, scheduler = null }) {
    this.shutdownFn = shutdown;
    this.scheduler = scheduler; // { schedule(seconds), abort() } — the OS owns the real deadline
    this.warn = warn;
    this.onState = onState;
    this.onEvent = onEvent;
    this.lastResult = null;
    this.timer = new ShutdownTimer({
      now,
      warnLeadMs,
      onChange: () => this._emit(),
      onEvent: (kind, data) => this._handleTimerEvent(kind, data),
    });
  }

  get state() {
    return {
      armed: this.timer.armed,
      paused: this.timer.paused,
      remaining: this.timer.remaining(),
      inGrace: this.timer.fired === true,
      lastResult: this.lastResult,
    };
  }

  start(minutes) { this.timer.start(minutes); this._sync(); return this.state; }
  adjust(minutes) { const r = this.timer.adjust(minutes); this._sync(); return r; }
  pause() { const r = this.timer.pause(); if (r) this._abortOs('paused'); return r; }
  resume() { const r = this.timer.resume(); this._sync(); return r; }
  cancel(reason) { return this.timer.cancel(reason); }

  /** Seconds until the real shutdown: the countdown plus the grace minute. */
  osSecondsLeft() {
    const t = this.timer;
    if (!t.armed || t.paused) return null;
    const left = t.remaining() ?? 0;
    return Math.ceil((t.fired ? left : left + t.fireGraceMs) / 1000);
  }

  _sync() {
    const secs = this.osSecondsLeft();
    if (secs === null || !this.scheduler) return;
    Promise.resolve(this.scheduler.schedule(secs))
      .then((res) => this.onEvent('os-scheduled', { seconds: secs, ...res }))
      .catch((err) => this.onEvent('os-scheduled', { seconds: secs, ok: false, error: String(err?.message ?? err) }));
  }

  _abortOs(reason) {
    if (!this.scheduler) return;
    Promise.resolve(this.scheduler.abort())
      .then((res) => this.onEvent('os-aborted', { reason, ...res }))
      .catch(() => {});
  }

  async _handleTimerEvent(kind, data) {
    this.onEvent(kind, data);
    // Any disarm except "it already fired" must take the OS shutdown back.
    if (kind === 'disarmed' && data?.reason !== 'fired') this._abortOs(data?.reason ?? 'cancel');
    if (kind === 'warning') {
      try {
        await this.warn();
        this.onEvent('warning-played');
      } catch (err) {
        this.onEvent('warning-failed', { error: String(err?.message ?? err) });
      }
    }
    if (kind === 'shutdown') {
      const result = await this.shutdownFn();
      this.lastResult = result;
      this.lastFiredAt = Date.now();
      this.timer.cancel('fired');
      this.onEvent('shutdown-result', result);
    }
    if (kind === 'countdown-ended') {
      this.onEvent('grace-started', { graceMs: this.timer.fireGraceMs });
    }
    this._emit();
  }

  _emit() { this.onState(this.state); }

  dispose() { this.timer.dispose(); }
}
