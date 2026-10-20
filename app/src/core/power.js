// src/core/power.js — OS-level shutdown, with a dry-run mode and an injectable runner.
//
// Windows: `shutdown /s /t 0` schedules the OS shutdown. We abort it on cancel
// where the platform allows it, because the app may still be closing.

import { spawn } from 'node:child_process';

export const COMMANDS = {
  win32: { args: ['/s', '/t', '0'], abort: ['/a'] },
  linux: { args: ['shutdown', 'now'], needsRoot: true },
  darwin: { args: ['shutdown', '-h', 'now'], needsRoot: true },
};

/**
 * @param {object} opts
 * @param {string} [opts.platform] overrides process.platform (tests)
 * @param {boolean} [opts.dryRun]
 * @param {(cmd: string, args: string[]) => Promise<{code:number, stderr?:string}>} [opts.run]
 */
export function createPower({ platform = process.platform, dryRun = false, run = defaultRun } = {}) {
  const spec = COMMANDS[platform];

  async function shutdown() {
    if (!spec) return { ok: false, error: `unsupported platform: ${platform}` };
    if (dryRun) return { ok: true, dryRun: true, wouldRun: spec.args.join(' ') };
    const cmd = spec.needsRoot ? 'sudo' : 'shutdown';
    const args = spec.needsRoot ? ['-n', ...spec.args] : spec.args;
    try {
      const res = await run(cmd, args);
      if (res.code !== 0) return { ok: false, error: res.stderr || `exit ${res.code}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  async function abort() {
    if (platform !== 'win32') return { ok: false, error: 'abort not applicable' };
    if (dryRun) return { ok: true, dryRun: true };
    const res = await run('shutdown', spec.abort);
    return { ok: res.code === 0, error: res.stderr };
  }

  return { shutdown, abort, platform, dryRun };
}

function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (b) => (stderr += b.toString()));
    child.on('error', (err) => resolve({ code: -1, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}
