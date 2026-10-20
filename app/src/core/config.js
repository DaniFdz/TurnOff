// src/core/config.js — persisted settings, plain JSON next to the user data dir.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULTS = {
  defaultMinutes: 30,
  warnLeadMinutes: 5,
  voiceBumpPercent: 5,
  leveling: false,
  levelingCeiling: -14,
  startMinimized: false,
  dryRun: false,
};

export function configPath() {
  if (process.env.TURNOFF_CONFIG) return process.env.TURNOFF_CONFIG;
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
  return join(base, 'TurnOff', 'settings.json');
}

export async function loadConfig(path = configPath()) {
  try {
    const raw = await readFile(path, 'utf8');
    return sanitize({ ...DEFAULTS, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(config, path = configPath()) {
  const clean = sanitize({ ...DEFAULTS, ...config });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

/** Unknown or hostile values must never reach the timer or the shutdown call. */
export function sanitize(config) {
  const num = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    defaultMinutes: num(config.defaultMinutes, 1, 720, DEFAULTS.defaultMinutes),
    warnLeadMinutes: num(config.warnLeadMinutes, 1, 60, DEFAULTS.warnLeadMinutes),
    voiceBumpPercent: num(config.voiceBumpPercent, 0, 100, DEFAULTS.voiceBumpPercent),
    leveling: Boolean(config.leveling),
    levelingCeiling: num(config.levelingCeiling, -60, 0, DEFAULTS.levelingCeiling),
    startMinimized: Boolean(config.startMinimized),
    dryRun: Boolean(config.dryRun),
  };
}
