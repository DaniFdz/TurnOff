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

A real audible warning works out of the box: `app/assets/voice/chime.wav` plays
when no voice clip exists yet, so the app is never silent. To get the voice,
drop the rendered clips in `app/assets/voice/`:

- `5m.mp3` — the 5 minute warning
- `2m.mp3`, `1m.mp3` — optional, for a shorter lead time
- `warn.mp3` — generic fallback if the timed one is missing

Render them once in VoiceStudio and commit them. Playback uses the same gain
rule as the app: measured playback peak +5% (`app/src/core/audio.js`), never a
system volume change, so it does not leave your volume slider somewhere else.

## Night mode (audio leveling)

Two halves, both honest about what they can measure:

- **The maths is real and tested** (`app/src/core/dynamics.js`): a compressor
  with fast attack (8 ms) and slow release (350 ms), a ceiling the signal never
  crosses, and a makeup gain that lifts quiet dialogue but never past that
  ceiling. 6 tests cover the gunshot case.
- **The meter is not faked.** `app/src/core/meter.js` reports
  `available: false` with a reason when there is no backend, and the UI says
  so instead of drawing decorative bars.

Remaining work, in order:

1. **Core Audio peak meter for Windows**: `IAudioMeterInformation::GetPeakValue`
   on the default render endpoint, as a native addon behind the existing
   `meter.read()` contract. Until then Windows reports "addon not installed".
2. **Apply the gain to the stream**: virtual cable or APO, driven by
   `Leveler.feed()`.
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
