#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# ── Android SDK ────────────────────────────────────────────────────────────────
SDK="$HOME/Library/Android/sdk"
export ANDROID_HOME="${ANDROID_HOME:-$SDK}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$SDK}"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools"

# ── Appium ─────────────────────────────────────────────────────────────────────
# IMPORTANT: this machine may run several app scrapers at once, each driving
# its own device. One Appium server can host all of their sessions, so reuse
# it instead of killing it — killing it here would drop every other app's
# active session.
if curl -s http://127.0.0.1:4723/status > /dev/null 2>&1; then
  echo "Appium server already running — reusing it (shared across concurrent scrapers)."
else
  echo "Starting Appium (ANDROID_HOME=$ANDROID_HOME)..."
  appium --log appium.log --log-level warn > /dev/null 2>&1 &

  # Poll for readiness instead of a blind sleep — a fixed 4s sleep isn't
  # always enough on a cold start and leaves the scraper hitting ECONNREFUSED.
  echo "  Waiting for Appium to come up…"
  for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:4723/status > /dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ! curl -s http://127.0.0.1:4723/status > /dev/null 2>&1; then
    echo "ERROR: Appium failed to start within 30s. Check appium.log"
    exit 1
  fi
  echo "  Appium is up."
fi

# ── Device check ───────────────────────────────────────────────────────────────
# Just a sanity check that *something* is connected — scraper.js / cf_scraper.js
# themselves prompt interactively to choose WHICH device if more than one is attached.
DEVICE_COUNT=$(adb devices | grep -v "List" | grep -c "device$" || true)
if [ "$DEVICE_COUNT" -eq 0 ]; then
  echo "No Android device found. Connect via USB with USB debugging enabled."
  exit 1
fi

# ── Dependencies ───────────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# ── Mode ───────────────────────────────────────────────────────────────────────
# Usage:
#   ./run.sh          — normal mode (auto list navigation, connect only)
#   ./run.sh --data   — data mode   (scrape all + connect, human navigation at pager end)
#   ./run.sh --cf     — connect-find mode (search aa→zz, connect new people, export CSV)

MODE=""
CF_MODE=false
for arg in "$@"; do
  case "$arg" in
    --data) MODE="--data" ;;
    --cf)   CF_MODE=true  ;;
  esac
done

if [ "$CF_MODE" = true ]; then
  echo "Starting ATx Enterprise 2026 Connector (--cf / Connect-Find mode)..."
  node cf_scraper.js
else
  echo "Starting ATx Enterprise 2026 Connector${MODE:+ ($MODE)}..."
  node scraper.js $MODE
fi
