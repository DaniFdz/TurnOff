// audio.js — plays the warning clip and reports back to the main process.
//
// The clip arrives as a blob URL (the main process reads it from the asar), so
// nothing here needs file-system access, and the volume is applied by the audio
// element itself: we never touch the system volume.

const player = document.getElementById('player');
const ring = document.getElementById('ring');
const pct = document.getElementById('pct');
const caption = document.getElementById('caption');

function report(type, data = {}) {
  window.turnoffAudio?.event(type, data);
}

player.addEventListener('timeupdate', () => {
  if (!player.duration || !Number.isFinite(player.duration)) return;
  const progress = Math.min(100, (player.currentTime / player.duration) * 100);
  ring.style.setProperty('--p', progress + '%');
  pct.textContent = Math.round(progress) + '%';
});

player.addEventListener('ended', () => report('ended'));
player.addEventListener('error', () =>
  report('error', { code: player.error?.code ?? 0, message: player.error?.message ?? 'unknown' }));

let objectUrl = null;

window.turnoffAudio.onPlay(async ({ path, gain, label }) => {
  try {
    caption.textContent = label ?? 'Warning';
    player.volume = Math.min(1, Math.max(0, gain));

    const { data, type } = window.turnoffAudio.readClip(path);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([data], { type }));
    player.src = objectUrl;

    await player.play();
    report('playing', { volume: player.volume, duration: player.duration || 0 });
  } catch (err) {
    report('error', { code: -1, message: String(err?.message ?? err) });
  }
});

// If playback outlives the visible window (it should not, it is short),
// never leave a dead overlay behind.
window.turnoffAudio.onClose(() => {
  player.pause();
  player.removeAttribute('src');
});
