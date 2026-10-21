// tests/timer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShutdownTimer, formatRemaining } from '../src/core/timer.js';

function harness(opts = {}) {
  let t = 1_000_000;
  const events = [];
  const timer = new ShutdownTimer({
    now: () => t,
    onEvent: (kind, data) => events.push({ kind, data }),
    ...opts,
  });
  const advance = (ms) => { t += ms; timer._tick(); };
  return { timer, advance, events };
}

test('start arms the countdown with the requested minutes', () => {
  const { timer } = harness();
  timer.start(10);
  assert.equal(timer.armed, true);
  assert.equal(timer.remaining(), 10 * 60_000);
  timer.dispose();
});

test('adjust moves the deadline forward and back', () => {
  const { timer } = harness();
  timer.start(10);
  timer.adjust(5);
  assert.equal(timer.remaining(), 15 * 60_000);
  timer.adjust(-7);
  assert.equal(timer.remaining(), 8 * 60_000);
  timer.dispose();
});

test('adjusting below the warning lead cancels instead of arming a silent window', () => {
  const { timer, events } = harness();
  timer.start(10);
  assert.equal(timer.adjust(-9.9), 'below-lead');
  assert.equal(timer.armed, false);
  assert.ok(events.some((e) => e.kind === 'disarmed' && e.data.reason === 'adjusted-below-lead'));
  timer.dispose();
});

test('pause freezes the remaining time and resume continues it', () => {
  const { timer, advance } = harness();
  timer.start(5);
  advance(60_000);
  timer.pause();
  const frozen = timer.remaining();
  advance(120_000);
  assert.equal(timer.remaining(), frozen);
  timer.resume();
  advance(60_000);
  assert.equal(timer.remaining(), frozen - 60_000);
  timer.dispose();
});

test('warnings fire at five minutes and again at one, once each', () => {
  const { timer, advance, events } = harness();
  timer.start(7);
  advance(90_000); // 5:30 left
  assert.equal(events.filter((e) => e.kind === 'warning').length, 0);
  advance(60_000); // 4:30 left, crossed 5
  assert.deepEqual(events.filter((e) => e.kind === 'warning').map((e) => e.data.leadMinutes), [5]);
  advance(60_000); // 3:30
  advance(60_000); // 2:30
  advance(60_000); // 1:30
  assert.equal(events.filter((e) => e.kind === 'warning').length, 1);
  advance(60_000); // 0:30, crossed 1
  assert.deepEqual(events.filter((e) => e.kind === 'warning').map((e) => e.data.leadMinutes), [5, 1]);
  timer.dispose();
});

test('adjusting does not replay a warning that already happened', () => {
  const { timer, advance, events } = harness();
  timer.start(7);
  advance(150_000); // past the 5 minute mark
  assert.equal(events.filter((e) => e.kind === 'warning').length, 1);
  timer.adjust(10);
  advance(60_000);
  assert.equal(events.filter((e) => e.kind === 'warning').length, 1, 'no second 5 minute warning');
  timer.dispose();
});

test('there is no extra minute: the shutdown fires at zero', () => {
  const { timer, advance, events } = harness();
  timer.start(1);
  advance(59_000);
  assert.equal(events.filter((e) => e.kind === 'shutdown').length, 0);
  advance(2_000);
  assert.equal(events.filter((e) => e.kind === 'shutdown').length, 1);
  assert.equal(timer.armed, false);
  timer.dispose();
});

test('the shutdown fires exactly once', () => {
  const { timer, advance, events } = harness();
  timer.start(1);
  advance(61_000);
  advance(61_000);
  advance(60_000);
  assert.equal(events.filter((e) => e.kind === 'shutdown').length, 1);
  timer.dispose();
});

test('cancel disarms and reports it only when something was armed', () => {
  const { timer, events } = harness();
  assert.equal(timer.cancel(), false);
  timer.start(5);
  assert.equal(timer.cancel(), true);
  assert.equal(events.filter((e) => e.kind === 'disarmed').length, 1);
  timer.dispose();
});

test('formatRemaining pads seconds and switches to hours', () => {
  assert.equal(formatRemaining(0), '00:00');
  assert.equal(formatRemaining(1_000), '00:01');
  assert.equal(formatRemaining(3_600_000), '1:00:00');
  assert.equal(formatRemaining(null), '--:--');
});
