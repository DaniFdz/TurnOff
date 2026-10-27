// tests/power.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPower, TASK_NAME } from '../src/core/power.js';

const at = (iso) => new Date(iso).getTime();

test('dry run never invokes the runner', async () => {
  let called = false;
  const power = createPower({ platform: 'win32', dryRun: true, run: async () => { called = true; return { code: 0 }; } });
  const res = await power.shutdown();
  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  assert.equal(called, false);
});

test('the shutdown itself is immediate and forced', async () => {
  const calls = [];
  const power = createPower({ platform: 'win32', run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0 }; } });
  await power.shutdown();
  assert.deepEqual(calls, [['shutdown', '/s', '/f', '/t', '0']]);
});

test('scheduling registers a silent one-shot task, not shutdown /t', async () => {
  const calls = [];
  const power = createPower({ platform: 'win32', now: () => at('2026-10-21T23:00:00'), run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0 }; } });
  const res = await power.scheduleAt(at('2026-10-21T23:30:00'));
  assert.equal(res.ok, true);
  assert.equal(calls[0][0], 'powershell.exe');
  const script = calls[0].join(' ');
  assert.match(script, new RegExp('TurnOffShutdown'));
  assert.match(script, /-At \(\[datetime\]'2026-10-21T23:30:00'\)/);
  assert.match(script, /shutdown\.exe' -Argument '\/s \/f \/t 0/);
  assert.equal(calls.some(([c]) => c === 'shutdown'), false, 'no shutdown /t and therefore no system toast');
});

test('the datetime handed to the task is ISO, so a Spanish Windows cannot misread it', () => {
  const power = createPower({ platform: 'win32' });
  assert.equal(power.iso(at('2026-03-09T21:05:07')), '2026-03-09T21:05:07');
});

test('a failed registration is reported, not retried blindly', async () => {
  const calls = [];
  const power = createPower({
    platform: 'win32', user: 'danif',
    run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 1, stderr: 'nope' }; },
  });
  const res = await power.schedule(600);
  assert.equal(res.ok, false);
  assert.match(res.error, /nope/);
});

test('abort always removes the task, even from a process that did not schedule it', async () => {
  const calls = [];
  const power = createPower({ platform: 'win32', run: async (cmd, args) => { calls.push(args.join(' ')); return { code: 0 }; } });
  // no schedule() in this instance: this is the --cancel process
  const res = await power.abort();
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Unregister-ScheduledTask -TaskName 'TurnOffShutdown'/);
});

test('unknown platforms are refused', async () => {
  const power = createPower({ platform: 'aix' });
  assert.equal((await power.shutdown()).ok, false);
  assert.equal((await power.schedule(10)).ok, false);
});
