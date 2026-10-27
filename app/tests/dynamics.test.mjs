// tests/dynamics.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { toDb, fromDb, targetGainDb, GainSmoother, Leveler } from '../src/core/dynamics.js';

test('dB conversions round-trip and handle silence', () => {
  assert.ok(Math.abs(toDb(1) - 0) < 1e-9);
  assert.ok(Math.abs(toDb(0.5) + 6.0206) < 1e-3);
  assert.equal(toDb(0), -Infinity);
  assert.ok(Math.abs(fromDb(-6.0206) - 0.5) < 1e-3);
});

test('a peak above the ceiling is pulled down to it', () => {
  const gain = targetGainDb(toDb(0.95), { ceilingDb: -14, makeupMaxDb: 12 });
  assert.ok(Math.abs(gain - (-14 - toDb(0.95))) < 1e-6);
  assert.ok(gain < 0);
});

test('quiet dialogue is lifted but never over the ceiling', () => {
  const gain = targetGainDb(-40, { ceilingDb: -14, makeupMaxDb: 12 });
  assert.equal(gain, 12); // capped by makeupMaxDb
  const gain2 = targetGainDb(-18, { ceilingDb: -14, makeupMaxDb: 12 });
  assert.ok(gain2 >= 0);
  assert.ok(-18 + gain2 <= -14); // stays under the ceiling
});

test('silence leaves the gain alone', () => {
  assert.equal(targetGainDb(-Infinity), 0);
});

test('attack is faster than release', () => {
  const s = new GainSmoother({ attackMs: 8, releaseMs: 400 });
  // ducking: 60 ms should be almost all the way
  let g = s.step(-12, 60);
  assert.ok(g < -10);
  s.reset();
  // lifting: 60 ms should still be far from the target
  g = s.step(12, 60);
  assert.ok(g < 3);
});

test('the leveler never lets a gunshot through at full scale', () => {
  const leveler = new Leveler({ ceilingDb: -14, attackMs: 8, releaseMs: 350 });
  let peakDb = -50;
  for (let i = 0; i < 20; i++) {
    const out = leveler.feed(0.0003, 16); // quiet dialogue
    peakDb = out.peakDb;
  }
  const loud = leveler.feed(0.98, 16); // gunshot
  assert.equal(loud.limited, true);
  assert.ok(loud.gainDb < 0);
  // and it keeps ducking on the next samples instead of bouncing back
  const next = leveler.feed(0.98, 16);
  assert.ok(next.gainDb <= loud.gainDb + 0.5);
});
