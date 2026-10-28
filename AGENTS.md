# Repository instructions

## macOS build commands

- When the user asks to "build the app" or says "앱 빌드", build only the macOS `.app` bundle with `npm run build:mac:app`.
- Build a DMG only when the user explicitly asks for a DMG, disk image, or distribution installer. Use `npm run build:mac:dmg` when the `.app` already exists, or `npm run build:mac` only when the user explicitly requests both the app and DMG.
- Do not interpret a generic app-build request as authorization to create a DMG.
- If the requested macOS artifact is ambiguous, default to the `.app` bundle only.
