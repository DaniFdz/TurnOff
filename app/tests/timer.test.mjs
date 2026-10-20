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
  return { timer, advance, events, now: () => t };
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
  const result = timer.adjust(-9.9);
  assert.equal(result, 'below-lead');
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

test('warning fires once when crossing the lead time', () => {
  const { timer, advance, events } = harness({ warnLeadMs: 5 * 60_000 });
  timer.start(6);
  advance(30_000);
  assert.equal(events.filter((e) => e.kind === 'warning').length, 0);
  advance(60_000);
  assert.equal(events.filter((e) => e.kind === 'warning').length, 1);
  advance(60_000);
  assert.equal(events.filter((e) => e.kind === 'warning').length, 1);
  timer.dispose();
});

test('shutdown fires exactly once at zero', () => {
  const { timer, advance, events } = harness();
  timer.start(1);
  advance(60_000);
  advance(60_000);
  assert.equal(events.filter((e) => e.kind === 'shutdown').length, 1);
  assert.equal(timer.armed, false);
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
  assert.equal(formatRemaining(59_400), '01:00');
  assert.equal(formatRemaining(3_600_000), '1:00:00');
  assert.equal(formatRemaining(null), '--:--');
});
