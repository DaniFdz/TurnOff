// tests/warning.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceWarning } from '../src/core/warning.js';
import { LevelSensor } from '../src/core/audio.js';

function make({ clips = { '5m.mp3': '/assets/5m.mp3' }, level = 0.4 } = {}) {
  const played = [];
  const sensor = new LevelSensor({ probe: async () => level });
  const warning = new VoiceWarning({
    playFile: async (path, gain) => { played.push({ path, gain }); },
    resolveClip: (name) => clips[name] ?? null,
    sensor,
    bump: 5,
  });
  return { warning, played };
}

test('plays the clip matching the lead time at playback level + bump', async () => {
  const { warning, played } = make();
  const res = await warning.play(5);
  assert.equal(res.ok, true);
  assert.equal(res.clip, '5m');
  assert.equal(played.length, 1);
  assert.ok(Math.abs(played[0].gain - 0.42) < 1e-9);
});

test('falls back to a generic clip when the timed one is missing', async () => {
  const { warning } = make({ clips: { 'warn.mp3': '/assets/warn.mp3' } });
  const res = await warning.play(5);
  assert.equal(res.ok, true);
  assert.equal(res.clip, 'warn');
});

test('missing assets are reported, not thrown', async () => {
  const { warning } = make({ clips: {} });
  const res = await warning.play(5);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-clip');
});

test('a second warning cannot start while one is playing', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const sensor = new LevelSensor({ probe: async () => 0.3 });
  const warning = new VoiceWarning({
    playFile: () => gate,
    resolveClip: () => '/assets/5m.mp3',
    sensor,
    bump: 5,
  });
  const first = warning.play(5);
  await new Promise((r) => setImmediate(r)); // let the first call reach playFile
  const second = await warning.play(5);
  assert.equal(second.reason, 'already-playing');
  release();
  await first;
});
