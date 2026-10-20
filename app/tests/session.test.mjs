// tests/session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { NightSession } from '../src/core/session.js';

function harness({ shutdownOk = true, warnThrows = false } = {}) {
  let t = 1_000_000;
  const events = [];
  let shutdowns = 0;
  const session = new NightSession({
    now: () => t,
    shutdown: async () => { shutdowns++; return { ok: shutdownOk, error: shutdownOk ? undefined : 'denied' }; },
    warn: async () => { if (warnThrows) throw new Error('no audio'); },
    warnLeadMs: 5 * 60_000,
    onEvent: (kind, data) => events.push({ kind, data }),
  });
  const advance = (ms) => { t += ms; session.timer._tick(); };
  return { session, advance, events, shutdowns: () => shutdowns };
}

test('the warning runs before the shutdown, and both happen once', async () => {
  const { session, advance, events } = harness();
  session.start(6);
  advance(90_000); // crosses the 5 minute lead
  await new Promise((r) => setImmediate(r));
  assert.ok(events.some((e) => e.kind === 'warning-played'));
  assert.equal(events.filter((e) => e.kind === 'shutdown').length, 0);

  advance(300_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(events.filter((e) => e.kind === 'shutdown').length, 1);
  assert.equal(session.state.armed, false);
  session.dispose();
});

test('a broken voice warning never blocks the shutdown', async () => {
  const { session, advance, events, shutdowns } = harness({ warnThrows: true });
  session.start(6);
  advance(90_000);
  advance(400_000);
  await new Promise((r) => setImmediate(r));
  assert.ok(events.some((e) => e.kind === 'warning-failed'));
  assert.equal(shutdowns(), 1);
  session.dispose();
});

test('a refused shutdown is reported, not swallowed', async () => {
  const { session, advance, events } = harness({ shutdownOk: false });
  session.start(1);
  advance(120_000);
  await new Promise((r) => setImmediate(r));
  const result = events.find((e) => e.kind === 'shutdown-result');
  assert.equal(result.data.ok, false);
  assert.equal(result.data.error, 'denied');
  session.dispose();
});
