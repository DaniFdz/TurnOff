// tests/config.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, DEFAULTS } from '../src/core/config.js';

test('sanitize keeps valid values', () => {
  const config = sanitize({ defaultMinutes: 45, voiceBumpPercent: 8, leveling: true });
  assert.equal(config.defaultMinutes, 45);
  assert.equal(config.voiceBumpPercent, 8);
  assert.equal(config.leveling, true);
});

test('sanitize clamps out-of-range numbers', () => {
  assert.equal(sanitize({ defaultMinutes: 0 }).defaultMinutes, 1);
  assert.equal(sanitize({ defaultMinutes: 99_999 }).defaultMinutes, 720);
  assert.equal(sanitize({ voiceBumpPercent: 500 }).voiceBumpPercent, 100);
});

test('sanitize replaces garbage with defaults', () => {
  const config = sanitize({ defaultMinutes: 'soon', leveling: 'yes please' });
  assert.equal(config.defaultMinutes, DEFAULTS.defaultMinutes);
  assert.equal(config.leveling, true); // any truthy value is fine; it is coerced to a boolean
  assert.equal(sanitize({ leveling: 0 }).leveling, false);
});

test('the old -14 dBFS default moves to -18 once, a real choice is kept', async () => {
  const { migrate, sanitize } = await import('../src/core/config.js');
  assert.equal(sanitize(migrate({ levelingCeiling: -14 }, { levelingCeiling: -14 })).levelingCeiling, -18);
  assert.equal(sanitize(migrate({ levelingCeiling: -22 }, { levelingCeiling: -22 })).levelingCeiling, -22);
  assert.equal(sanitize(migrate({ levelingCeiling: -14 }, { levelingCeiling: -14, schema: 2 })).levelingCeiling, -14);
});
