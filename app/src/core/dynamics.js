// src/core/dynamics.js — the leveling maths, without touching any audio device.
//
// Night mode is a compressor/limiter, not a volume knob: fast attack so a
// gunshot is caught, slow release so speech does not pump, and a ceiling the
// signal never crosses. This module only decides the gain; the platform
// adapter is responsible for applying it.

export const DEFAULTS = {
  ceilingDb: -14, // peaks are pulled down to here
  targetDb: -24, // where dialogue should sit
  attackMs: 8,
  releaseMs: 350,
  makeupMaxDb: 12, // how far we are willing to lift quiet dialogue
};

/** Linear 0..1 amplitude to dBFS. Silence is -Infinity, never a crash. */
export function toDb(amplitude) {
  const a = Math.max(0, Number(amplitude) || 0);
  return a > 0 ? 20 * Math.log10(a) : -Infinity;
}

export function fromDb(db) {
  if (db === -Infinity) return 0;
  return Math.pow(10, db / 20);
}

/**
 * Gain (in dB) needed for a measured peak, before smoothing.
 * Peaks above the ceiling are attenuated; quiet material is lifted up to
 * makeupMaxDb but never past the ceiling.
 */
export function targetGainDb(peakDb, opts = DEFAULTS) {
  const { ceilingDb, makeupMaxDb } = opts;
  if (!Number.isFinite(peakDb)) return 0; // silence: leave the gain alone
  if (peakDb > ceilingDb) return ceilingDb - peakDb; // pull the peak down
  // Lift quiet material, but never push it over the ceiling.
  const lift = Math.min(makeupMaxDb, ceilingDb - peakDb - 6);
  return Math.max(0, lift);
}

/**
 * One-pole smoothing of the gain, asymmetric: attack is fast, release slow.
 * `dtMs` is the time since the previous sample.
 */
export class GainSmoother {
  constructor(opts = DEFAULTS) {
    this.opts = { ...DEFAULTS, ...opts };
    this.gainDb = 0;
  }

  step(wantedDb, dtMs) {
    const dt = Math.max(1, dtMs);
    const coeff = (timeMs) => Math.exp(-dt / timeMs);
    const isReducing = wantedDb < this.gainDb;
    const tc = isReducing ? this.opts.attackMs : this.opts.releaseMs;
    const c = coeff(tc);
    this.gainDb = wantedDb + (this.gainDb - wantedDb) * c;
    return this.gainDb;
  }

  reset() { this.gainDb = 0; }
}

/**
 * Turns a stream of peak measurements into gain values.
 * Pure: feed it peaks, get the gain to apply, no device access.
 */
export class Leveler {
  constructor(opts = DEFAULTS) {
    this.opts = { ...DEFAULTS, ...opts };
    this.smoother = new GainSmoother(this.opts);
    this.lastPeak = null;
  }

  /** @param {number} peak 0..1
   *  @param {number} dtMs milliseconds since the previous call
   *  @returns {{gainDb:number, peakDb:number, limited:boolean}} */
  feed(peak, dtMs) {
    const peakDb = toDb(peak);
    this.lastPeak = Number.isFinite(peakDb) ? peakDb : this.lastPeak;
    const wanted = targetGainDb(peakDb, this.opts);
    const gainDb = this.smoother.step(wanted, dtMs);
    return {
      gainDb,
      peakDb,
      limited: peakDb > this.opts.ceilingDb,
    };
  }

  reset() { this.smoother.reset(); this.lastPeak = null; }
}
