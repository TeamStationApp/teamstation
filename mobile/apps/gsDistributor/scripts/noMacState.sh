#!/usr/bin/env bash
# Checks GS Distributor keeps nothing on the Mac: runs the app against the attached iPad (it
# connects, reads the recordings and settings, and asks for a PeerTube token), quits it, and fails
# if it left preferences, saved window state, caches, cookies or support files behind.
#
# Quits any running GS Distributor first. Needs an iPad with GS Director open.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

APP="${APP:-$DISTRIBUTOR_ROOT/DerivedData/Build/Products/Debug/GS Distributor.app}"
[ -d "$APP" ] || fail "build first: scripts/build.sh"
BUNDLE=co.gamestation.distributor
PLACES=(
  "$HOME/Library/Preferences/$BUNDLE.plist"
  "$HOME/Library/Saved Application State/$BUNDLE.savedState"
  "$HOME/Library/Caches/$BUNDLE"
  "$HOME/Library/HTTPStorages/$BUNDLE"
  "$HOME/Library/HTTPStorages/$BUNDLE.binarycookies"
  "$HOME/Library/Application Support/$BUNDLE"
  "$HOME/Library/WebKit/$BUNDLE"
)

quit_app() {
  # AppKit will not quit while a sheet is up; put a finished export's progress away first.
  curl -s -m 2 http://127.0.0.1:8768/dismiss-export >/dev/null 2>&1 || true
  osascript -e "tell application id \"$BUNDLE\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    pgrep -f "GS Distributor.app/Contents/MacOS" >/dev/null || return 0
    sleep 0.25
  done
  fail "GS Distributor did not quit"
}

quit_app
# Anything left by an earlier build is not this run's doing; clear it so the check is honest.
for place in "${PLACES[@]}"; do rm -rf "$place"; done
defaults delete "$BUNDLE" >/dev/null 2>&1 || true

log "Launching GS Distributor"
open "$APP" --args -harness
connected=0
for _ in $(seq 1 60); do
  if curl -s -m 2 http://127.0.0.1:8768/dump-state | grep -q '"state" : "connected"'; then connected=1; break; fi
  sleep 0.5
done
[ $connected -eq 1 ] || { quit_app; fail "GS Distributor did not connect to GS Director"; }
# Long enough for the settings and the PeerTube account to load.
sleep 3
quit_app
# cfprefsd writes preferences out lazily; give it a moment.
sleep 2

LEFT=()
for place in "${PLACES[@]}"; do [ -e "$place" ] && LEFT+=("$place"); done
[ ${#LEFT[@]} -eq 0 ] || fail "left on the Mac: ${LEFT[*]}"
log "Nothing left on the Mac"
