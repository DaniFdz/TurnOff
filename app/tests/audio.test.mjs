// tests/audio.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { warningGain, LevelSensor } from '../src/core/audio.js';

test('warning gain sits 5% above the measured playback level', () => {
  assert.ok(Math.abs(warningGain(0.4, 5) - 0.42) < 1e-9);
  assert.ok(Math.abs(warningGain(0.5, 10) - 0.55) < 1e-9);
});

test('warning gain never exceeds the endpoint and keeps a floor', () => {
  assert.equal(warningGain(0.99, 5), 1);
  assert.equal(warningGain(0.001, 5), 0.05);
});

test('warning gain falls back when nothing is measured', () => {
  assert.ok(Math.abs(warningGain(null, 5, 0.3) - 0.315) < 1e-9);
  assert.ok(Math.abs(warningGain(0, 5, 0.3) - 0.315) < 1e-9);
});

test('sensor keeps the last real reading when the probe goes quiet', async () => {
  let value = 0.5;
  const sensor = new LevelSensor({ probe: async () => value });
  assert.equal(await sensor.sample(), 0.5);
  assert.equal(sensor.source, 'meter');

  value = 0; // the series went silent
  assert.equal(await sensor.sample(), 0.5);
  assert.equal(sensor.source, 'stale');
});

test('a failing probe never throws', async () => {
  const sensor = new LevelSensor({ probe: async () => { throw new Error('no device'); } });
  assert.equal(await sensor.sample(), null);
  assert.equal(sensor.source, 'none');
});
