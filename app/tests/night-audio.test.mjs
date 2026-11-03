// tests/night-audio.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NightAudio, LEVELER_DEFAULTS } from '../src/core/night-audio.js';

function fakeHelper() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.sent = [];
  child.stdin = { write: (s) => child.sent.push(s.trim()) };
  child.kill = () => child.emit('exit', null);
  child.say = (obj) => child.stdout.write(JSON.stringify(obj) + '\r\n');
  return child;
}
const tick = () => new Promise((r) => setImmediate(r));

test('reports unavailable until the helper is ready, then live levels', async () => {
  const child = fakeHelper();
  const na = new NightAudio({ spawn: () => child });
  na.start();
  assert.equal(na.snapshot().available, false);
  assert.equal(na.snapshot().reason, 'starting');
  child.say({ t: 'ready' });
  child.say({ t: 'level', ok: true, peak: 0.5, vol: -13.6, gain: 0, on: false });
  await tick();
  const s = na.snapshot();
  assert.equal(s.available, true);
  assert.equal(s.peak, 0.5);
  assert.ok(Math.abs(s.peakDb - -6.02) < 0.01);
  assert.equal(s.gainDb, null, 'no cut is reported while leveling is off');
});

test('enable before ready is sent once the helper is ready', async () => {
  const child = fakeHelper();
  const na = new NightAudio({ spawn: () => child });
  na.start();
  na.setEnabled(true, { ceilingDb: -20 });
  assert.deepEqual(child.sent, []);
  child.say({ t: 'ready' });
  await tick();
  assert.deepEqual(child.sent, ['on -20 5 1500 400 24']);
  na.setEnabled(false);
  assert.equal(child.sent.at(-1), 'off');
});

test('unknown or garbage options never reach the helper', () => {
  const na = new NightAudio({ spawn: () => fakeHelper() });
  na.setEnabled(true, { ceilingDb: 'loud', evil: 'rm -rf', releaseMs: 900 });
  assert.equal(na.command(), ['on', LEVELER_DEFAULTS.ceilingDb, 5, 900, 400, 24].join(' '));
});

test('a crashed helper is restarted and gets the leveling state back', async () => {
  const children = [fakeHelper(), fakeHelper()];
  let n = 0;
  const na = new NightAudio({ spawn: () => children[n++], restartDelayMs: 1 });
  na.start();
  children[0].say({ t: 'ready' });
  await tick();
  na.setEnabled(true);
  children[0].emit('exit', 1);
  assert.equal(na.snapshot().available, false);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(n, 2);
  children[1].say({ t: 'ready' });
  await tick();
  assert.match(children[1].sent[0], /^on /);
});

test('restarts are capped, then the reason says it crashed', async () => {
  let t = 0;
  const na = new NightAudio({ spawn: () => { const c = fakeHelper(); setImmediate(() => c.emit('exit', 1)); return c; }, restartDelayMs: 1, maxRestarts: 2, now: () => t });
  na.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(na.snapshot().reason, 'helper-crashed');
});

test('stop sends quit and does not restart', async () => {
  let spawned = 0;
  const child = fakeHelper();
  const na = new NightAudio({ spawn: () => { spawned++; return child; }, restartDelayMs: 1 });
  na.start();
  na.stop();
  assert.equal(child.sent.at(-1), 'quit');
  child.emit('exit', 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(spawned, 1);
});

test('the cut is reported while leveling is on', async () => {
  const child = fakeHelper();
  const na = new NightAudio({ spawn: () => child });
  na.start();
  child.say({ t: 'level', ok: true, peak: 0.9, vol: -20, gain: -7.5, on: true });
  await tick();
  assert.equal(na.snapshot().gainDb, -7.5);
  assert.equal(na.snapshot().leveling, true);
});
