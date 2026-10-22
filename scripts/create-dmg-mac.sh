#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION=$(node -p "require('./package.json').version")
PRODUCT_NAME=$(node -p "require('./package.json').build.productName")
ARCH=$(uname -m | sed 's/x86_64/x64/')

APP_PATH="release/mac-${ARCH}/${PRODUCT_NAME}.app"
DMG_PATH="release/${PRODUCT_NAME}-${VERSION}-${ARCH}.dmg"

if [ ! -d "$APP_PATH" ]; then
  echo "Error: .app not found at $APP_PATH"
  echo "Run 'npm run build:mac:app' first"
  exit 1
fi

bash scripts/ensure-mac-app-signature.sh "$APP_PATH"

rm -f "$DMG_PATH"

echo "Creating DMG: $DMG_PATH"

set +e
create-dmg \
  --volname "AI Assessment Assistant Installer" \
  --background "scripts/resources/background.png" \
  --window-size 560 360 \
  --icon-size 86 \
  --icon "${PRODUCT_NAME}.app" 145 205 \
  --app-drop-link 415 205 \
  "$DMG_PATH" \
  "$APP_PATH"
EXIT_CODE=$?
set -e

# exit code 2 = no code signing, DMG still created successfully
if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 2 ]; then
  echo "Error: create-dmg failed (exit $EXIT_CODE)"
  exit $EXIT_CODE
fi

echo "Done: $DMG_PATH"
