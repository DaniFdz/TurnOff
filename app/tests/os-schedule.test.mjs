
import test from 'node:test';
import assert from 'node:assert/strict';
import { NightSession } from '../src/core/session.js';
import { createPower } from '../src/core/power.js';

function make() {
  let t = 1_000_000;
  const os = [];
  const s = new NightSession({
    now: () => t,
    shutdown: async () => ({ ok: true }),
    warn: async () => {},
    warnLeadMs: 5 * 60_000,
    scheduler: { schedule: async (sec) => { os.push(['schedule', sec]); return { ok: true }; }, abort: async () => { os.push(['abort']); return { ok: true }; } },
  });
  const advance = (ms) => { t += ms; s.timer._tick(); };
  return { s, os, advance };
}
const flush = () => new Promise((r) => setImmediate(r));

test('arming hands Windows the deadline plus the grace minute', async () => {
  const { s, os } = make();
  s.start(30); await flush();
  assert.deepEqual(os.at(-1), ['schedule', 30 * 60 + 60]);
  s.dispose();
});

test('adjusting reschedules, pausing and cancelling abort', async () => {
  const { s, os } = make();
  s.start(30); s.adjust(-5); await flush();
  assert.deepEqual(os.at(-1), ['schedule', 25 * 60 + 60]);
  s.pause(); await flush();
  assert.deepEqual(os.at(-1), ['abort']);
  s.resume(); await flush();
  assert.deepEqual(os.at(-1), ['schedule', 25 * 60 + 60]);
  s.cancel('ui'); await flush();
  assert.deepEqual(os.at(-1), ['abort']);
  s.dispose();
});

test('after the shutdown fires nothing aborts it', async () => {
  const { s, os, advance } = make();
  s.start(1); await flush();
  advance(60_000); advance(61_000); await flush(); await flush();
  assert.notDeepEqual(os.at(-1), ['abort']);
  s.dispose();
});

test('pausing during the grace minute really pauses', async () => {
  const { s, advance } = make();
  s.start(1); advance(61_000);
  assert.equal(s.state.inGrace, true);
  s.pause();
  advance(120_000);
  assert.equal(s.state.paused, true);
  assert.equal(s.state.armed, true);
  s.dispose();
});

test('windows schedule replaces any pending shutdown', async () => {
  const calls = [];
  const power = createPower({ platform: 'win32', run: async (cmd, args) => { calls.push(args.join(' ')); return { code: 0 }; } });
  const res = await power.schedule(1860);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ['/a', '/s /t 1860 /c TurnOff']);
});

