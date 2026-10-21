// src/core/power.js — OS-level shutdown, with a dry-run mode and an injectable runner.
//
// Windows: the deadline is handed to Task Scheduler (`schtasks`) instead of
// `shutdown /s /t N`. That matters for more than tidiness:
//   - `shutdown /s /t` shows a system notification every time it is issued, and
//     cancelling it shows another one, so every +/- click spammed the user;
//   - re-issuing it while one is pending fails with 1190 unless it is aborted
//     first, which is exactly the second notification.
// A one-shot task is silent, can be moved with `/change`, and survives this app
// crashing. It fires `shutdown /s /f /t 0` (no countdown, nothing to cancel).

import { spawn } from 'node:child_process';

export const TASK_NAME = 'TurnOffShutdown';

export const COMMANDS = {
  win32: { args: ['/s', '/f', '/t', '0'], task: 'shutdown /s /f /t 0' },
  linux: { args: ['shutdown', 'now'], needsRoot: true },
  darwin: { args: ['shutdown', '-h', 'now'], needsRoot: true },
};

const iso = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// Task Scheduler through PowerShell, not schtasks: `schtasks /sd` takes the
// *local* date format, and a Spanish Windows rejected "10/22/2026" outright.
// The cmdlets take a DateTime, so the locale cannot break the schedule.
const registerScript = (task, atIso) => [
  "$ErrorActionPreference='Stop'",
  `$action=New-ScheduledTaskAction -Execute 'shutdown.exe' -Argument '/s /f /t 0'`,
  `$trigger=New-ScheduledTaskTrigger -Once -At ([datetime]'${atIso}')`,
  `$principal=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive`,
  `Register-ScheduledTask -TaskName '${task}' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null`,
  "'ok'",
].join('; ');

const unregisterScript = (task) =>
  `$ErrorActionPreference='SilentlyContinue'; Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false; 'ok'`;

const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/**
 * @param {object} opts
 * @param {string} [opts.platform] overrides process.platform (tests)
 * @param {boolean} [opts.dryRun]
 * @param {() => number} [opts.now]
 * @param {string} [opts.user]
 * @param {(cmd: string, args: string[]) => Promise<{code:number, stderr?:string}>} [opts.run]
 */
export function createPower({ platform = process.platform, dryRun = false, run = defaultRun, now = () => Date.now(), user = process.env.USERNAME } = {}) {
  const spec = COMMANDS[platform];
  let scheduledAt = null; // ms, only when we know a task exists

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
    // Deliberately unconditional: --cancel arrives in a *second process* (the
    // single-instance lock forwards argv), so this instance cannot know whether
    // the running one scheduled a task. Missing task is fine.
    scheduledAt = null;
    await run(POWERSHELL[0], [...POWERSHELL.slice(1), unregisterScript(TASK_NAME)]);
    return { ok: true };
  }

  /**
   * Move (or create) the silent one-shot task so Windows shuts down at `atMs`.
   * No system notification, and it happens even if this app dies.
   */
  async function scheduleAt(atMs) {
    if (platform !== 'win32') return { ok: false, error: 'schedule not applicable' };
    const at = iso(atMs);
    if (dryRun) return { ok: true, dryRun: true, at };
    const res = await run(POWERSHELL[0], [...POWERSHELL.slice(1), registerScript(TASK_NAME, at)]);
    if (res.code === 0) {
      scheduledAt = atMs;
      return { ok: true, at };
    }
    return { ok: false, error: (res.stderr || res.stdout || `exit ${res.code}`).slice(0, 300) };
  }

  function schedule(seconds) {
    const secs = Math.max(0, Math.min(315_360_000, Math.round(seconds)));
    return scheduleAt(now() + secs * 1000);
  }

  return { shutdown, abort, schedule, scheduleAt, platform, dryRun, iso, get scheduled() { return scheduledAt !== null; } };
}

function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => (stdout += b.toString()));
    child.stderr?.on('data', (b) => (stderr += b.toString()));
    child.on('error', (err) => resolve({ code: -1, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
