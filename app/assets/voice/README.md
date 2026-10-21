# Voice clips

Drop the VoiceStudio renders here, named by lead time:

- `5m.mp3` — "in five minutes I'm shutting the PC down"
- `2m.mp3`, `1m.mp3` — optional shorter warnings
- `warn.mp3` — generic fallback

They are played through the app's gain rule (measured playback peak + N%),
not at a fixed system volume. See `src/core/audio.js`.
