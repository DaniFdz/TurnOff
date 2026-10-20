# TurnOff v2 — voice warning + night mode

Redesign of TurnOff: same philosophy (shut the PC down at bedtime), but it now
warns you by voice before shutting down and can tame the audio of whatever you
are watching.

The v1 app (`src/TurnOff.py`) stays in the tree until v2 ships a signed build.

## Download

Windows builds live under [Releases](https://github.com/DaniFdz/TurnOff/releases).
There is no Python setup and no virtualenv anymore: the app is a single
installer.

## What changed

| | v1 | v2 |
|---|---|---|
| UI | Flet (`while True` + `page.update()`) | Electron, frameless window, tray |
| Timer | fixed 30 min, no warning | configurable, pause/resume, voice warning N min before |
| Warning sound | fixed mp3 at system volume | voice clip played at playback level **+N%** |
| Audio | – | night mode: leveling for dialogue vs. gunfights |
| Shutdown | `shutdown /s /t 1` at T+1 min | `shutdown /s /t 0` at T, dry-run mode for testing |

## Running it

```bash
cd app
npm install
npm run build        # bundles the renderer into dist/
npm test             # core logic tests, no GUI needed
npx electron .       # dev run
```

`app/` is plain Node + Electron. The core (`app/src/core/`) has no Electron
imports on purpose: the timer, the audio-gain math and the power call are all
testable with `node --test`.

## Voice warning

Drop the rendered clips in `app/assets/voice/`:

- `5m.mp3` — the 5 minute warning
- `2m.mp3`, `1m.mp3` — optional, for a shorter lead time
- `warn.mp3` — generic fallback if the timed one is missing

Render them once in VoiceStudio and commit them. Playback uses the same gain
rule as the app: measured playback peak +5% (`app/src/core/audio.js`), never a
system volume change, so it does not leave your volume slider somewhere else.

## Night mode (audio leveling)

Settings and the UI exist, but the audio path is **not wired yet**: the meter in
the UI is a placeholder and no DSP is applied to the system output.

The plan, in order of least surprises:

1. **Measure** the default render endpoint with Core Audio
   (`IAudioMeterInformation::GetPeakValue`). This gives the warning its real
   gain instead of a fallback.
2. **Process** the stream with a compressor/limiter (fast attack, slow release,
   ceiling) through a virtual cable or an APO, and expose only three knobs:
   ceiling, smoothness, makeup gain.
3. Measure added latency and keep it under ~30 ms, otherwise audio drifts
   against video.

## Layout

```
app/
  src/core/       timer, session, power, audio gain, voice warning, config, ipc
  src/renderer/   UI (HTML/CSS/JS, no framework)
  src/main.js     Electron main: window, tray, IPC wiring
  src/preload.cjs context bridge
  scripts/        renderer build
  tests/          node:test suites
  assets/voice/   voice clips (mp3)
mockup/           static HTML mockup used to agree on the design first
src/              v1 Python app
```
