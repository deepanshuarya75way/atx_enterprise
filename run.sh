#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# ── Android SDK ────────────────────────────────────────────────────────────────
SDK="$HOME/Library/Android/sdk"
export ANDROID_HOME="${ANDROID_HOME:-$SDK}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$SDK}"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools"

# ── Appium ─────────────────────────────────────────────────────────────────────
# Kill any running Appium and start fresh so it inherits ANDROID_HOME above.
pkill -f "node.*appium" 2>/dev/null || true
sleep 1
echo "Starting Appium (ANDROID_HOME=$ANDROID_HOME)..."
appium --log appium.log --log-level warn > /dev/null 2>&1 &
sleep 4

# ── Device check ───────────────────────────────────────────────────────────────
DEVICE=$(adb devices | grep -v "List" | grep "device$" | awk '{print $1}' | head -1)
if [ -z "$DEVICE" ]; then
  echo "No Android device found. Connect via USB with USB debugging enabled."
  exit 1
fi
echo "Device: $DEVICE"

# ── Dependencies ───────────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# ── Mode ───────────────────────────────────────────────────────────────────────
# Usage:
#   ./run.sh          — normal mode (auto list navigation, connect only)
#   ./run.sh --data   — data mode   (scrape all + connect, human navigation at pager end)

MODE=""
for arg in "$@"; do
  case "$arg" in
    --data) MODE="--data" ;;
  esac
done

echo "Starting ATx Enterprise 2026 Connector${MODE:+ ($MODE)}..."
node scraper.js $MODE
