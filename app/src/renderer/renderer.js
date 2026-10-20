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
  ceilingRange: $('ceilingRange'),
  ceilingValue: $('ceilingValue'),
  leadValue: $('leadValue'),
  bumpRange: $('bumpRange'),
  bumpValue: $('bumpValue'),
  preview: $('previewBtn'),
  chime: $('chimeBtn'),
  audioNote: $('audioNote'),
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

  const inGrace = state.inGrace === true;
  els.timer.textContent = armed || inGrace ? fmt(remaining) : fmt(config.defaultMinutes * 60_000);
  if (inGrace) {
    els.eyebrow.textContent = 'Shutting down';
    els.sub.textContent = `Last minute — ${formatGrace(remaining)} to stop it`;
    els.main.textContent = 'Stop';
  } else {
    els.main.textContent = !armed
      ? `Start ${config.defaultMinutes} min`
      : paused
        ? 'Resume countdown'
        : 'Pause countdown';
  }
  els.cancel.disabled = !armed;
  renderAgenda();
}

function formatGrace(ms) {
  const s = Math.max(0, Math.ceil((ms ?? 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
  els.ceilingRange.value = config.levelingCeiling;
  els.ceilingValue.textContent = config.levelingCeiling + ' dBFS';
  els.leadValue.textContent = `${config.warnLeadMinutes} min before`;
  els.bumpRange.value = config.voiceBumpPercent;
  els.bumpValue.textContent = `+${config.voiceBumpPercent}% vs. playback`;
}

// Meter. When the backend reports no device, the UI says so — no invented bars.
const HISTORY = 20;
const history = new Array(HISTORY).fill(0);

// Bars are drawn in dB (-60..0 dBFS): a linear scale makes dialogue invisible.
function barLevel(v) {
  if (typeof v !== 'number' || v <= 0) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(v) + 60) / 60));
}

function renderMeter() {
  const meter = config.levels;
  const available = Boolean(meter?.available);
  const ceiling = config.levelingCeiling ?? -18;
  bars.forEach((bar, i) => {
    const v = history[i] ?? 0;
    const level = barLevel(v);
    const db = v > 0 ? 20 * Math.log10(v) : -99;
    bar.style.height = (available ? Math.max(4, level * 100) : 4) + '%';
    bar.className = !available ? 'off' : config.leveling && db > ceiling ? 'peak' : db > ceiling - 6 ? 'hot' : '';
  });
  if (!available) {
    els.peak.textContent = 'n/a';
    els.gain.textContent = '–';
    els.meterNote.textContent = explainMeter(meter?.reason);
    return;
  }
  const db = state.peakDb ?? null;
  els.peak.textContent = db === null ? '−∞' : db.toFixed(1) + ' dBFS';
  if (!config.leveling) {
    els.gain.textContent = '–';
    els.meterNote.textContent = 'Leveler off · meter only';
    return;
  }
  const cut = state.gainDb;
  const cutting = cut !== null && cut !== undefined && cut <= -0.1;
  els.gain.textContent = cutting ? cut.toFixed(1) + ' dB' : '0 dB';
  els.meterNote.textContent = cutting
    ? 'Turning a loud scene down ' + Math.abs(cut).toFixed(0) + ' dB'
    : 'Listening · cuts anything above ' + ceiling + ' dBFS';
}

function explainMeter(reason) {
  if (!reason || reason === 'starting') return 'Starting the audio meter…';
  if (reason === 'compile-failed') return 'Audio helper could not be built (see boot.log)';
  if (reason === 'helper-crashed') return 'Audio helper keeps crashing (see boot.log)';
  if (reason === 'helper-exited') return 'Audio helper restarting…';
  if (reason === 'no-device') return 'No playback device';
  if (reason.startsWith('unsupported-platform') || reason.includes('not-implemented')) return 'Leveling needs Windows';
  return 'Meter unavailable (' + reason + ')';
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

function describePlayback(res) {
  if (!res?.ok) return `No audio available (${res?.reason ?? 'unknown'}).`;
  const what = res.kind === 'chime' ? 'Chime' : `Voice clip "${res.clip}"`;
  return `${what} played at ${(res.gain * 100).toFixed(0)}% volume (peak was ${res.level === null ? 'unknown' : Math.round(res.level * 100) + '%'}).`;
}

els.preview.addEventListener('click', async () => {
  const res = await api.previewWarning();
  flashHint(describePlayback(res), !res?.ok);
});

els.chime.addEventListener('click', async () => {
  const res = await api.previewChime();
  flashHint(describePlayback(res), !res?.ok);
});

els.leveling.addEventListener('change', async () => {
  config = await api.setConfig({ leveling: els.leveling.checked });
  renderConfig();
});

els.ceilingRange.addEventListener('input', () => {
  els.ceilingValue.textContent = els.ceilingRange.value + ' dBFS';
});
els.ceilingRange.addEventListener('change', async () => {
  const levels = config.levels;
  config = await api.setConfig({ levelingCeiling: Number(els.ceilingRange.value) });
  config.levels = levels;
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
