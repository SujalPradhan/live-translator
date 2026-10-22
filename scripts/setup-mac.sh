#!/usr/bin/env bash
# One-time macOS setup: installs two independent BlackHole loopback drivers
# (one per translation direction) and the app's JavaScript dependencies.
# Safe to re-run; already-installed parts are skipped.
set -euo pipefail

cd "$(dirname "$0")/.."
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == Darwin ]] || fail 'This script is for macOS. On Linux the app creates its own virtual devices.'
major=$(sw_vers -productVersion | cut -d. -f1)
(( major >= 13 )) || fail "macOS 13 Ventura or later is required (found $(sw_vers -productVersion))."

step 'Checking Homebrew'
if ! command -v brew >/dev/null; then
  fail 'Homebrew is required to install the audio drivers. Install it from https://brew.sh:
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
then run this script again.'
fi
echo "Found $(brew --version | head -1)"

step 'Checking Node.js 22.12+'
command -v node >/dev/null || fail 'Node.js is missing. Install it with "brew install node@22" or nvm, then run this script again.'
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' ||
  fail "Node.js 22.12 or later is required (found $(node -v)). Upgrade with \"brew install node@22\" or \"nvm install 22\"."
echo "Found Node.js $(node -v)"

step 'Installing virtual audio cables (BlackHole 2ch + BlackHole 16ch)'
# Two separate drivers are two independent buses: 2ch carries your translated
# voice into the meeting, 16ch carries the meeting audio back to the app.
installed=0
for cask in blackhole-2ch blackhole-16ch; do
  if brew list --cask "$cask" >/dev/null 2>&1; then
    echo "$cask is already installed."
  else
    echo "Installing $cask (macOS may ask for your password)…"
    brew install --cask "$cask"
    installed=1
  fi
done
if (( installed )); then
  step 'Restarting Core Audio so the new devices appear'
  if ! sudo killall coreaudiod; then
    echo 'Could not restart Core Audio. Restart your Mac before starting the app.'
  fi
fi

step 'Installing app dependencies'
if [[ -d node_modules/electron ]]; then echo 'Dependencies already installed.'; else npm install; fi

cat <<'EOF'

Setup complete.

  1. Start the app:          npm start
  2. Allow microphone access when macOS asks.
  3. Settings → Gemini:      enter your API key and save.
     Settings → Virtual devices fills in the BlackHole cables automatically.
  4. In Meet / Zoom choose:  Microphone = BlackHole 2ch
                             Speaker    = BlackHole 16ch
EOF
