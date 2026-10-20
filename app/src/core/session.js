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
  constructor({ shutdown, warn, now, onState = () => {}, onEvent = () => {}, warnLeadMs = 5 * 60_000 }) {
    this.shutdownFn = shutdown;
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

  start(minutes) { this.timer.start(minutes); return this.state; }
  adjust(minutes) { return this.timer.adjust(minutes); }
  pause() { return this.timer.pause(); }
  resume() { return this.timer.resume(); }
  cancel(reason) { return this.timer.cancel(reason); }

  async _handleTimerEvent(kind, data) {
    this.onEvent(kind, data);
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
