// tests/session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { NightSession } from '../src/core/session.js';

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function harness({ shutdownOk = true, warnThrows = false } = {}) {
  let t = 1_000_000;
  const events = [];
  const os = [];
  let shutdowns = 0;
  const session = new NightSession({
    now: () => t,
    shutdown: async () => { shutdowns++; return { ok: shutdownOk, error: shutdownOk ? undefined : 'denied' }; },
    warn: async (lead) => { if (warnThrows) throw new Error('no audio'); events.push({ kind: 'warn-called', data: { lead } }); },
    onEvent: (kind, data) => events.push({ kind, data }),
    scheduler: {
      schedule: async (sec) => { os.push(['schedule', sec]); return { ok: true }; },
      abort: async () => { os.push(['abort']); return { ok: true }; },
    },
    syncDebounceMs: 5,
  });
  const advance = (ms) => { t += ms; session.timer._tick(); };
  return { session, advance, events, os, shutdowns: () => shutdowns };
}

test('arming hands the deadline to the OS once, after the debounce', async () => {
  const { session, os } = harness();
  session.start(30);
  assert.deepEqual(os, [], 'nothing is scheduled synchronously');
  await flush(20);
  assert.deepEqual(os, [['schedule', 30 * 60]]);
  session.dispose();
});

test('rapid +/- clicks produce a single reschedule', async () => {
  const { session, os } = harness();
  session.start(30);
  session.adjust(5);
  session.adjust(5);
  session.adjust(-1);
  await flush(30);
  assert.equal(os.length, 1, 'only the last submission went out');
  assert.deepEqual(os[0], ['schedule', 39 * 60]);
  session.dispose();
});

test('pausing and cancelling take the OS task back', async () => {
  const { session, os } = harness();
  session.start(30);
  await flush(20);
  session.pause();
  await flush(20);
  assert.deepEqual(os.at(-1), ['abort']);
  session.resume();
  await flush(20);
  assert.deepEqual(os.at(-1), ['schedule', 30 * 60]);
  session.cancel('ui');
  await flush(20);
  assert.deepEqual(os.at(-1), ['abort']);
  session.dispose();
});

test('the two warnings carry their lead time', async () => {
  const { session, advance, events } = harness();
  session.start(7);
  advance(120_000); // 5:00 left
  advance(60_000);
  await flush();
  advance(60_000);
  advance(60_000);
  advance(60_000);
  await flush();
  const leads = events.filter((e) => e.kind === 'warn-called').map((e) => e.data.lead);
  assert.deepEqual(leads, [5, 1]);
  session.dispose();
});

test('a broken warning never blocks the shutdown', async () => {
  const { session, advance, events, shutdowns } = harness({ warnThrows: true });
  session.start(1);
  advance(60_000);
  await flush();
  assert.ok(events.some((e) => e.kind === 'warning-failed'));
  assert.equal(shutdowns(), 1);
  session.dispose();
});

test('a refused shutdown is reported, not swallowed', async () => {
  const { session, advance, events } = harness({ shutdownOk: false });
  session.start(1);
  advance(61_000);
  await flush();
  const result = events.find((e) => e.kind === 'shutdown-result');
  assert.equal(result.data.ok, false);
  assert.equal(result.data.error, 'denied');
  session.dispose();
});
