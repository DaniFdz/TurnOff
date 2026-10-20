# Building TurnOff for Windows

The app is plain Electron + esbuild, so it builds anywhere. What differs is the
packaging step.

## From Windows (recommended, produces the installer)

```powershell
cd app
npm install
npm run dist          # build + electron-builder -> release/TurnOff Setup 2.0.0.exe
```

## From Linux (what CI does, produces a portable folder)

```bash
cd app
npm install
npm run build                                       # renderer only
npx electron-builder --win portable --x64 --publish never -c.win.signAndEditExecutable=false
# -> release/win-unpacked/TurnOff.exe
```

`signAndEditExecutable=false` skips `rcedit`, which needs Wine on Linux. The
result is an unpacked portable build with the Electron icon: it runs, it is just
not renamed/iconised. On Windows the same command produces the NSIS installer
with the proper exe metadata and icon.

## Notes

- Nothing here is signed. Windows will show "Unknown publisher" on first run.
- The voice clips must exist in `app/assets/voice/` **before** building: they are
  packed into the asar.
