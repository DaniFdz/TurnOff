// tests/power.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPower } from '../src/core/power.js';

test('dry run never invokes the runner', async () => {
  let called = false;
  const power = createPower({ platform: 'win32', dryRun: true, run: async () => { called = true; return { code: 0 }; } });
  const res = await power.shutdown();
  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  assert.equal(called, false);
});

test('windows shutdown goes through shutdown /s /t 0', async () => {
  const calls = [];
  const power = createPower({ platform: 'win32', run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0 }; } });
  const res = await power.shutdown();
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['shutdown', '/s', '/t', '0']]);
});

test('a failing command surfaces stderr instead of pretending success', async () => {
  const power = createPower({ platform: 'win32', run: async () => ({ code: 1, stderr: 'Access denied' }) });
  const res = await power.shutdown();
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Access denied');
});

test('unknown platforms are refused', async () => {
  const power = createPower({ platform: 'aix' });
  const res = await power.shutdown();
  assert.equal(res.ok, false);
});
