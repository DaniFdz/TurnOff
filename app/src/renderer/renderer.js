// renderer.js — presentation only. All state arrives from the main process.

const api = window.turnoff;

const $ = (id) => document.getElementById(id);
const els = {
  timer: $('timer'),
  eyebrow: $('timerEyebrow'),
  sub: $('timerSub'),
  ring: $('ring'),
  main: $('mainAction'),
  cancel: $('cancelBtn'),
  hint: $('hint'),
  levelChip: $('levelChip'),
  dryChip: $('dryChip'),
  levelStatus: $('levelStatus'),
  leveling: $('levelingToggle'),
  leadRange: $('leadRange'),
  leadValue: $('leadValue'),
  bumpRange: $('bumpRange'),
  bumpValue: $('bumpValue'),
  preview: $('previewBtn'),
  meter: $('meter'),
  peak: $('peakValue'),
  gain: $('gainValue'),
  meterNote: $('meterNote'),
  agenda: $('agenda'),
  dryToggle: $('dryToggle'),
  minimize: $('minimizeBtn'),
  hide: $('hideBtn'),
  quit: $('quitBtn'),
  footNote: $('footNote'),
};

const BARS = 20;
for (let i = 0; i < BARS; i++) els.meter.appendChild(document.createElement('span'));
const bars = [...els.meter.children];

// leveling/levels mirror the backend; nothing here guesses them.
let config = { defaultMinutes: 30, warnLeadMinutes: 5, voiceBumpPercent: 5, leveling: false, dryRun: false, levelingCeiling: -14, levels: { available: false, reason: 'starting', peak: null } };
let state = { armed: false, paused: false, remaining: null };
let totalMs = config.defaultMinutes * 60_000;

// ── formatting ──────────────────────────────────────────────
function fmt(ms) {
  if (ms === null || ms === undefined) return '--:--';
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

function clock(msFromNow) {
  if (msFromNow === null) return '';
  const d = new Date(Date.now() + msFromNow);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── render ──────────────────────────────────────────────────
function renderState() {
  const { armed, paused, remaining } = state;
  if (state.meter) config.levels = state.meter;
  if (config.levels?.available && typeof config.levels.peak === 'number') {
    pushPeak(config.levels.peak);
  } else if (config.leveling) {
    pushPeak(0);
  }
  renderMeter();
  els.timer.textContent = armed ? fmt(remaining) : fmt(config.defaultMinutes * 60_000);
  els.timer.classList.toggle('warn', armed && remaining <= config.warnLeadMinutes * 60_000 + 30_000);
  els.timer.classList.toggle('urgent', armed && remaining <= 60_000);
  els.eyebrow.textContent = paused ? 'Paused' : 'Shutdown in';

  if (!armed) {
    els.sub.textContent = 'Not armed';
    els.ring.style.width = '0%';
  } else {
    const pct = Math.max(0, Math.min(100, (remaining / Math.max(totalMs, 1)) * 100));
    els.ring.style.width = pct + '%';
    els.sub.textContent = paused
      ? `Paused with ${fmt(remaining)} left`
      : `Shutting down at ${clock(remaining)} · voice warning ${config.warnLeadMinutes} min before`;
  }

  els.main.textContent = !armed
    ? `Start ${config.defaultMinutes} min`
    : paused
      ? 'Resume countdown'
      : 'Pause countdown';
  els.cancel.disabled = !armed;
  renderAgenda();
}

function renderAgenda() {
  const { armed, paused, remaining } = state;
  if (!armed) {
    els.agenda.innerHTML = '<div class="empty">Arm a countdown to see the schedule.</div>';
    return;
  }
  const warnIn = remaining - config.warnLeadMinutes * 60_000;
  const rows = [
    { at: paused ? '—' : clock(remaining - warnIn), what: `Voice warning <small>(playback +${config.voiceBumpPercent}%)</small>`, tag: `${config.warnLeadMinutes} min`, next: warnIn > 0 },
    { at: paused ? '—' : clock(remaining), what: 'Shutdown', tag: 'PC', next: warnIn <= 0 },
  ];
  els.agenda.innerHTML = rows
    .map(
      (r) => `<div class="row${r.next ? ' next' : ''}"><span class="t">${r.at}</span><span class="what">${r.what}</span><span class="tag">${r.tag}</span></div>`,
    )
    .join('');
}

function renderConfig() {
  els.leveling.checked = Boolean(config.leveling);
  els.levelStatus.classList.toggle('on', Boolean(config.leveling));
  els.levelStatus.lastChild.textContent = config.leveling ? ' Audio leveler on' : ' Audio leveler off';
  els.levelChip.hidden = !config.leveling;
  els.dryChip.hidden = !config.dryRun;
  els.dryToggle.textContent = `Dry run: ${config.dryRun ? 'on' : 'off'}`;
  els.dryToggle.style.color = config.dryRun ? 'var(--accent)' : '';

  els.leadRange.value = config.warnLeadMinutes;
  els.leadValue.textContent = `${config.warnLeadMinutes} min before`;
  els.bumpRange.value = config.voiceBumpPercent;
  els.bumpValue.textContent = `+${config.voiceBumpPercent}% vs. playback`;
}

// Meter. When the backend reports no device, the UI says so — no invented bars.
const HISTORY = 20;
const history = new Array(HISTORY).fill(0);

function renderMeter() {
  const meter = config.levels;
  const available = Boolean(meter?.available);
  bars.forEach((bar, i) => {
    const value = history[i] ?? 0;
    const h = available ? Math.max(4, Math.min(100, value * 100)) : 4;
    bar.style.height = h + '%';
    bar.className = available ? (value > 0.85 ? 'peak' : value > 0.6 ? 'hot' : '') : 'off';
  });
  if (!config.leveling) {
    els.peak.textContent = '–';
    els.gain.textContent = '–';
    els.meterNote.textContent = 'Leveler off';
    return;
  }
  if (!available) {
    els.peak.textContent = 'n/a';
    els.gain.textContent = '–';
    els.meterNote.textContent = explainMeter(meter?.reason);
    return;
  }
  const db = state.peakDb ?? null;
  els.peak.textContent = db === null ? '–' : `${db.toFixed(1)} dB`;
  els.gain.textContent = state.gainDb === null || state.gainDb === undefined ? '–' : `${state.gainDb > 0 ? '+' : ''}${state.gainDb.toFixed(1)} dB`;
  els.meterNote.textContent = 'Live peak · ceiling ' + config.levelingCeiling + ' dB';
}

function explainMeter(reason) {
  if (!reason) return 'No meter';
  if (reason.includes('addon')) return 'Meter unavailable: Core Audio addon not installed';
  if (reason.includes('not-implemented')) return 'Meter unavailable on this platform';
  return `Meter unavailable (${reason})`;
}

function pushPeak(peak) {
  history.push(typeof peak === 'number' ? Math.min(1, Math.max(0, peak)) : 0);
  history.shift();
}

// ── actions ─────────────────────────────────────────────────
els.main.addEventListener('click', async () => {
  if (!state.armed) {
    totalMs = config.defaultMinutes * 60_000;
    await api.start(config.defaultMinutes);
  } else if (state.paused) {
    await api.resume();
  } else {
    await api.pause();
  }
});

els.cancel.addEventListener('click', () => api.cancel());

document.querySelectorAll('.q').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const delta = Number(btn.dataset.adjust);
    if (!state.armed) {
      await api.start(Math.max(1, config.defaultMinutes + delta));
      return;
    }
    const result = await api.adjust(delta);
    totalMs = Math.max(totalMs, (state.remaining ?? 0) + delta * 60_000);
    if (result === 'below-lead') flashHint(`Too short: cancelled to keep the ${config.warnLeadMinutes} min warning.`, true);
  });
});

els.preview.addEventListener('click', async () => {
  const res = await api.previewWarning();
  if (res?.ok) flashHint(`Warning played (${res.clip}, gain ${(res.gain * 100).toFixed(0)}%).`);
  else flashHint(`No warning audio available (${res?.reason ?? 'unknown'}).`, true);
});

els.leveling.addEventListener('change', async () => {
  config = await api.setConfig({ leveling: els.leveling.checked });
  renderConfig();
});

els.leadRange.addEventListener('input', () => {
  els.leadValue.textContent = `${els.leadRange.value} min before`;
});
els.leadRange.addEventListener('change', async () => {
  config = await api.setConfig({ warnLeadMinutes: Number(els.leadRange.value) });
  renderConfig();
  renderState();
});
els.bumpRange.addEventListener('change', async () => {
  config = await api.setConfig({ voiceBumpPercent: Number(els.bumpRange.value) });
  renderConfig();
  renderState();
});

els.dryToggle.addEventListener('click', async () => {
  config = await api.setConfig({ dryRun: !config.dryRun });
  renderConfig();
});

// ── window controls ─────────────────────────────────────────
els.minimize.addEventListener('click', () => api.minimize());
els.hide.addEventListener('click', () => api.hide());
els.quit.addEventListener('click', () => api.quit());

let hintTimer = null;
function flashHint(text, isError = false) {
  els.hint.textContent = text;
  els.hint.classList.toggle('error', isError);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    els.hint.textContent = 'Nothing is scheduled.';
    els.hint.classList.remove('error');
  }, 4000);
}

// ── keyboard ────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') { e.preventDefault(); els.main.click(); }
  if (e.key === '+' || e.key === '=') api.adjust(5);
  if (e.key === '-' || e.key === '_') api.adjust(-5);
  if (e.key === 'Escape') api.cancel();
});

// ── boot ────────────────────────────────────────────────────
api.onState((next) => { state = next; renderState(); });
api.onEvent(({ kind, data }) => {
  if (kind === 'warning') flashHint('Voice warning played.');
  if (kind === 'warning-failed') flashHint(`Voice warning failed: ${data?.error ?? 'unknown'}`, true);
  if (kind === 'shutdown-result') {
    flashHint(data?.ok ? (data.dryRun ? 'Dry run: would shut down now.' : 'Shutdown sent.') : `Shutdown failed: ${data?.error}`, !data?.ok);
  }
});

(async () => {
  config = await api.getConfig();
  renderConfig();
  renderState();

  const src = await api.getSource();
  els.quit.title = `Quit TurnOff ${src.version} completely`;
  els.quit.textContent = `Quit · v${src.version}`;
  els.footNote.title = `Settings: ${src.config}\nUser data: ${src.userData}`;
})();
