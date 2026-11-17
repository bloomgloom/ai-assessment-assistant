# Repository instructions

## macOS build commands

- When the user asks to "build the app" or says "앱 빌드", build only the macOS `.app` bundle with `npm run build:mac:app`.
- Build a DMG only when the user explicitly asks for a DMG, disk image, or distribution installer. Use `npm run build:mac:dmg` when the `.app` already exists, or `npm run build:mac` only when the user explicitly requests both the app and DMG.
- Do not interpret a generic app-build request as authorization to create a DMG.
- If the requested macOS artifact is ambiguous, default to the `.app` bundle only.

## Live user data protection

- Unless the user explicitly requests it in the current task, do not open, read, list, search, query, copy, inspect, modify, or delete data used by the user's installed/running app.
- Live user data includes databases, uploads, submissions, artifacts, backups, logs containing user content, and all files under `/Users/user/Library/Application Support/ai-assessment-assistant/` or any other configured app storage directory.
- Do not launch or automate the installed app, attach to its running process, or use its UI for verification when doing so would load or expose live user data, unless the user explicitly requests that access.
- Building, installing, debugging, testing, or diagnosing the app does not imply permission to access live user data or launch the installed app. Use synthetic fixtures and an isolated temporary storage directory for all tests and verification.
- Develop and verify database schema changes and migrations against an isolated temporary database. Access or modify the live database only when the user explicitly asks to apply, repair, or verify a migration against their actual data.
- Before any authorized live-database write, confirm the exact database target, make a recoverable backup, and use the narrowest safe operation or transaction. Do not directly edit unrelated rows or files.
- When the user explicitly authorizes live-data access, limit access to the specific data and operation requested; do not inspect unrelated records or files.
