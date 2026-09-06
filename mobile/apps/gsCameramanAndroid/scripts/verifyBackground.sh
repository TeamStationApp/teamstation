#!/usr/bin/env bash
# The one thing the iOS build cannot do, so the one thing that needs its own check.
#
# Pulls the stream three times — foregrounded, backgrounded, and with the screen off — and fails if
# the frame rate collapses or the listener stops answering in any of them. iOS suspends a
# backgrounded app and the listener stops accepting, which from the Mac is indistinguishable from a
# server that never bound; this proves Android does not.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require adb
require node
require ffmpeg

SECONDS_PER_PHASE="${SECONDS_PER_PHASE:-6}"
# 30 fps nominal. Below this the encoder is being scheduled out, which is the failure this looks for.
MINIMUM_FPS="${MINIMUM_FPS:-25}"

DEVICE="$(resolveDevice)"
mkdir -p "$CAMERAMAN_OUT"

bash "$CAMERAMAN_ROOT/scripts/install.sh"
bash "$CAMERAMAN_ROOT/scripts/launch.sh" uiTest true
forwardControl
for _ in $(seq 1 30); do
  if controlGet /dump-state >/dev/null 2>&1; then break; fi
  sleep 1
done

PORT="$(boundPort)" || fail "the app never reported a bound listener"
HOST="${CAMERAMAN_HOST:-$(deviceAddress)}"

pull() {
  local label="$1" out="$CAMERAMAN_OUT/background-$1.h264"
  rm -f "$out"
  local report
  report="$(node "$CAMERAMAN_IOS_SCRIPTS/rtspClient.js" \
    --host "$HOST" --port "$PORT" --path "live/mainstream" \
    --seconds "$SECONDS_PER_PHASE" --out "$out")" || fail "$label: the client could not pull"

  local fps gaps
  fps="$(printf '%s\n' "$report" | awk -F': ' '/measuredFrameRate/ {print $2}')"
  gaps="$(printf '%s\n' "$report" | awk -F': ' '/sequenceGaps/ {print $2}')"
  log "$label: ${fps} fps, ${gaps} sequence gaps"

  node -e "process.exit(Number('$fps') >= $MINIMUM_FPS ? 0 : 1)" \
    || fail "$label: frame rate collapsed to $fps"
  [ "$gaps" = "0" ] || fail "$label: $gaps sequence gaps"

  # Decoding it as well, because a stream can hold its rate and still be undecodable.
  ffmpeg -hide_banner -v error -i "$out" -f null - 2>"$CAMERAMAN_OUT/background-$1-decode.log"
  [ -s "$CAMERAMAN_OUT/background-$1-decode.log" ] && fail "$label: decoded with errors"
  return 0
}

log "Phase 1: foregrounded"
pull foreground

log "Phase 2: backgrounded"
adb -s "$DEVICE" shell input keyevent KEYCODE_HOME
sleep 2
pull background

# The ongoing notification is what the platform requires in exchange for background camera access,
# and the only way back into a Cameraman whose activity has been swiped away. Read from dumpsys
# rather than the shade, so a handset that has locked itself does not fail the check.
if adb -s "$DEVICE" shell dumpsys notification --noredact 2>/dev/null \
  | grep -q "$CAMERAMAN_PACKAGE"; then
  log "notification posted"
else
  fail "backgrounded with no ongoing notification — the service is not properly foregrounded"
fi

log "Phase 3: screen off"
adb -s "$DEVICE" shell input keyevent KEYCODE_SLEEP
sleep 3
pull screenoff

adb -s "$DEVICE" shell input keyevent KEYCODE_WAKEUP
log "Background streaming verified in all three phases"
