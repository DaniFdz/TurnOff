// src/core/warning.js — the voice warning itself: pick a clip, scale it, play it.
//
// Clips live in app/assets/voice/ as <minutes>m.mp3 ("5m.mp3" for the 5 minute
// warning). They are rendered offline in VoiceStudio, so playback is instant
// and does not depend on any TTS service being reachable.

const CLIP_NAMES = ['5m', '2m', '1m', 'warn'];

export class VoiceWarning {
  /**
   * @param {object} deps
   * @param {(path: string, gain: number) => Promise<void>} deps.playFile
   * @param {(name: string) => string|null} deps.resolveClip asset lookup
   * @param {import('./audio.js').LevelSensor} deps.sensor
   * @param {number} [deps.bump]
   * @param {(msg: string, data?: object) => void} [deps.log]
   */
  constructor({ playFile, resolveClip, sensor, bump = 5, log = () => {} }) {
    this.playFile = playFile;
    this.resolveClip = resolveClip;
    this.sensor = sensor;
    this.bump = bump;
    this.log = log;
    this.playing = false;
  }

  /** @param {number} leadMinutes minutes before shutdown, used to pick the clip */
  async play(leadMinutes = 5) {
    if (this.playing) return { ok: false, reason: 'already-playing' };
    const clip = this._pickClip(leadMinutes);
    if (!clip) {
      this.log('warning: no clip found in assets/voice');
      return { ok: false, reason: 'no-clip' };
    }
    const level = await this.sensor.sample();
    const { warningGain } = await import('./audio.js');
    const gain = warningGain(level, this.bump);
    this.playing = true;
    try {
      await this.playFile(clip.path, gain);
      return { ok: true, clip: clip.name, gain, level, source: this.sensor.source };
    } finally {
      this.playing = false;
    }
  }

  _pickClip(leadMinutes) {
    const preferred = [`${Math.round(leadMinutes)}m`, 'warn'];
    for (const name of preferred) {
      const path = this.resolveClip(`${name}.mp3`);
      if (path) return { name, path };
    }
    for (const fallback of CLIP_NAMES) {
      const path = this.resolveClip(`${fallback}.mp3`);
      if (path) return { name: fallback, path };
    }
    return null;
  }
}
