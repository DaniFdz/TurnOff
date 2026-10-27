// banner.js — the always-on-top warning card.
//
// Windows silences tray notifications while a video plays fullscreen (Focus
// Assist switches itself on), and the log showed the toast being sent anyway.
// This window sits above borderless fullscreen players, so the warning is seen.

const title = document.getElementById('title');
const body = document.getElementById('body');
const hint = document.getElementById('hint');
const mark = document.querySelector('.mark');

window.turnoffBanner.onShow(({ title: t, body: b, badge }) => {
  title.textContent = t ?? 'TurnOff';
  body.textContent = b ?? '';
  if (badge) mark.textContent = badge;
});

window.turnoffBanner.onClose(() => window.close());

// Clicking it dismisses early; the main process closes it anyway.
document.addEventListener('click', () => window.turnoffBanner.dismiss());
