// src/core/session.js — deep module tying the countdown, the voice warnings and the power call.
// The UI and the tray both talk to this and nothing else.

import { ShutdownTimer, DEFAULT_WARN_LEADS_MS } from './timer.js';

// Rapid +/- clicks must not reschedule the OS task on every press: one
// submission after the user stops for a moment.
const SYNC_DEBOUNCE_MS = 700;

export class NightSession {
  /**
   * @param {object} deps
   * @param {() => Promise<{ok:boolean, error?:string}>} deps.shutdown
   * @param {(leadMinutes: number) => Promise<void>} deps.warn
   * @param {() => number} [deps.now]
   * @param {(state: object) => void} [deps.onState]
   * @param {(event: string, data?: object) => void} [deps.onEvent]
   * @param {{schedule:(s:number)=>Promise<any>, abort:()=>Promise<any>}} [deps.scheduler]
   */
  constructor({ shutdown, warn, now, onState = () => {}, onEvent = () => {}, warnLeadsMs = DEFAULT_WARN_LEADS_MS, scheduler = null, syncDebounceMs = SYNC_DEBOUNCE_MS }) {
    this.shutdownFn = shutdown;
    this.warn = warn;
    this.onState = onState;
    this.onEvent = onEvent;
    this.scheduler = scheduler;
    this.syncDebounceMs = syncDebounceMs;
    this.lastResult = null;
    this.pendingSync = null;
    this.timer = new ShutdownTimer({
      now,
      warnLeadsMs,
      onChange: () => this._emit(),
      onEvent: (kind, data) => this._handleTimerEvent(kind, data),
    });
  }

  get state() {
    return {
      armed: this.timer.armed,
      paused: this.timer.paused,
      remaining: this.timer.remaining(),
      lastResult: this.lastResult,
    };
  }

  start(minutes) { this.timer.start(minutes); this._sync(); return this.state; }
  adjust(minutes) { const r = this.timer.adjust(minutes); this._sync(); return r; }
  pause() { const r = this.timer.pause(); if (r) this._abortOs('paused'); return r; }
  resume() { const r = this.timer.resume(); this._sync(); return r; }
  cancel(reason) { return this.timer.cancel(reason); }

  /** Seconds until the shutdown the OS should perform, or null. */
  osSecondsLeft() {
    const t = this.timer;
    if (!t.armed || t.paused) return null;
    return Math.ceil((t.remaining() ?? 0) / 1000);
  }

  _sync() {
    if (!this.scheduler) return;
    const secs = this.osSecondsLeft();
    if (this.pendingSync) clearTimeout(this.pendingSync);
    if (secs === null) { this.pendingSync = null; return; }
    this.pendingSync = setTimeout(() => {
      this.pendingSync = null;
      const at = this.osSecondsLeft();
      if (at === null) return;
      Promise.resolve(this.scheduler.schedule(at))
        .then((res) => this.onEvent('os-scheduled', { seconds: at, ...res }))
        .catch((err) => this.onEvent('os-scheduled', { seconds: at, ok: false, error: String(err?.message ?? err) }));
    }, this.syncDebounceMs);
    this.pendingSync.unref?.();
  }

  _abortOs(reason) {
    if (this.pendingSync) { clearTimeout(this.pendingSync); this.pendingSync = null; }
    if (!this.scheduler) return;
    Promise.resolve(this.scheduler.abort())
      .then((res) => this.onEvent('os-aborted', { reason, ...res }))
      .catch(() => {});
  }

  async _handleTimerEvent(kind, data) {
    this.onEvent(kind, data);
    // Any disarm must take the OS task back.
    if (kind === 'disarmed') this._abortOs(data?.reason ?? 'cancel');
    if (kind === 'warning') {
      const lead = data?.leadMinutes ?? 5;
      try {
        await this.warn(lead);
        this.onEvent('warning-played', { leadMinutes: lead });
      } catch (err) {
        this.onEvent('warning-failed', { leadMinutes: lead, error: String(err?.message ?? err) });
      }
    }
    if (kind === 'shutdown') {
      const result = await this.shutdownFn();
      this.lastResult = result;
      this.onEvent('shutdown-result', result);
    }
    this._emit();
  }

  _emit() { this.onState(this.state); }

  dispose() {
    if (this.pendingSync) clearTimeout(this.pendingSync);
    this.timer.dispose();
  }
}
