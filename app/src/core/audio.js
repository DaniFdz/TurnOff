// src/core/audio.js — where the voice warning gets its gain from.
//
// The requirement: the warning must be heard at the same level as what is
// currently playing, plus a small bump (+5% by default). That means we never
// touch the system volume: we scale the clip with the measured playback peak.
//
// A real peak meter on Windows comes from Core Audio
// (IAudioMeterInformation::GetPeakValue on the default render endpoint), which
// needs native code. Until that probe ships, the meter is fed by
// `player` (this app's own playback) and falls back to the last known value.

export class LevelSensor {
  /**
   * @param {object} deps
   * @param {() => Promise<number|null>} [deps.probe] returns 0..1 or null
   * @param {number} [deps.floor] lowest level we still trust as "something is playing"
   */
  constructor({ probe = async () => null, floor = 0.02 } = {}) {
    this.probe = probe;
    this.floor = floor;
    this.last = null;
    this.source = 'none';
    this.meter = null;
  }

  /** Feed live measurements from the Meter; `null` means "no meter". */
  attachMeter(meter) {
    this.meter = meter;
    if (!meter) return;
    meter.onSample((snap) => {
      if (snap.available && typeof snap.peak === 'number' && snap.peak > this.floor) {
        this.last = clamp01(snap.peak);
        this.source = 'meter';
      } else if (snap.available === false && this.last !== null) {
        this.source = 'stale';
      }
    });
  }

  async sample() {
    try {
      const value = await this.probe();
      if (typeof value === 'number' && Number.isFinite(value) && value > this.floor) {
        this.last = clamp01(value);
        this.source = 'meter';
        return this.last;
      }
    } catch {
      // A failing probe must never break the warning; fall through.
    }
    this.source = this.last === null ? 'none' : 'stale';
    return this.last;
  }
}

/**
 * Compute the gain multiplier for the warning clip.
 * @param {number|null} level 0..1 measured playback level
 * @param {number} bump percent above playback (default 5)
 * @param {number} fallback used when nothing is playing / no meter
 */
export function warningGain(level, bump = 5, fallback = 0.35) {
  const base = typeof level === 'number' && level > 0 ? clamp01(level) : clamp01(fallback);
  const gain = base * (1 + bump / 100);
  // Keep the clip audible but never clip the endpoint.
  return Math.min(1, Math.max(0.05, gain));
}

export function clamp01(n) { return Math.min(1, Math.max(0, n)); }
