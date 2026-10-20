// src/core/warning.js — the voice warning itself: pick a clip, scale it, play it.
//
// Clips live in app/assets/voice/ as <minutes>m.mp3 ("5m.mp3" for the 5 minute
// warning). They are rendered offline in VoiceStudio, so playback is instant
// and does not depend on any TTS service being reachable.

// Clip kinds. A voice clip always wins; when none has been rendered yet the
// chime still gives a real audible warning instead of silence.
const CLIP_NAMES = ['5m', '2m', '1m', 'warn'];
const CLIP_KINDS = ['voice', 'chime'];

export class VoiceWarning {
  /**
   * @param {object} deps
   * @param {(path: string, gain: number) => Promise<void>} deps.playFile
   * @param {(name: string) => string|null} deps.resolveClip asset lookup
   * @param {import('./audio.js').LevelSensor} deps.sensor
   * @param {number} [deps.bump]
   * @param {(msg: string, data?: object) => void} [deps.log]
   */
  constructor({ playFile, resolveClip, sensor, bump = 5, kind = null, log = () => {} }) {
    this.kind = kind;
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
    const clip = this._pickClip(leadMinutes, this.kind);
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
      return { ok: true, clip: clip.name, kind: clip.kind, gain, level, source: this.sensor.source };
    } finally {
      this.playing = false;
    }
  }

  _pickClip(leadMinutes, forced = null) {
    const exts = ['.mp3', '.wav', '.ogg'];
    const lookup = (name) => {
      for (const ext of exts) {
        const path = this.resolveClip(`${name}${ext}`);
        if (path) return { name, path };
      }
      return null;
    };
    const kinds = forced ? [forced] : CLIP_KINDS;
    for (const kind of kinds) {
      const preferred = kind === 'chime' ? ['chime'] : [`${Math.round(leadMinutes)}m`, 'warn'];
      for (const name of preferred) {
        const hit = lookup(name);
        if (hit) return { ...hit, kind };
      }
      if (kind === 'voice') {
        for (const fallback of CLIP_NAMES) {
          const hit = lookup(fallback);
          if (hit) return { ...hit, kind };
        }
      }
    }
    return null;
  }
}
