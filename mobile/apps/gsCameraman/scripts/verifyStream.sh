#!/usr/bin/env bash
# End-to-end check: build, run on the handset, pull the stream over RTSP with an independent client,
# and decode every frame with ffmpeg.
#
# The Node client in scripts/rtspClient.js is the judge here. It shares no code with the app, so it
# fails on anything that is not correct on the wire, and ffmpeg is then a third opinion on the bytes
# it collected.
#
#   bash scripts/verifyStream.sh hevc
#   STREAM_SECONDS=10 bash scripts/verifyStream.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcrun
require node
require ffprobe

CODEC="${CODEC:-h264}"
STREAM_SECONDS="${STREAM_SECONDS:-8}"

# Refuse what we don't understand rather than testing h264 and reporting success for it.
if [ $# -gt 1 ]; then
  fail "usage: verifyStream.sh [h264|hevc]"
fi
if [ $# -eq 1 ]; then
  case "$1" in
    h264 | hevc) CODEC="$1" ;;
    *) fail "unknown codec '$1' (expected h264 or hevc)" ;;
  esac
fi
EXTENSION="h264"
[ "$CODEC" = "hevc" ] && EXTENSION="h265"

VIDEO="$CAMERAMAN_DERIVED_DATA/stream-$CODEC.$EXTENSION"
AUDIO="$CAMERAMAN_DERIVED_DATA/stream-$CODEC.aac"
CONSOLE="$CAMERAMAN_DERIVED_DATA/stream-$CODEC.log"
mkdir -p "$CAMERAMAN_DERIVED_DATA"
rm -f "$VIDEO" "$AUDIO"

log "Building and installing"
LAUNCH=0 bash "$CAMERAMAN_ROOT/scripts/build-device.sh" >/dev/null

# The app has to stay in the foreground for the whole run: iOS suspends a backgrounded app and the
# listener stops accepting, which from the Mac is indistinguishable from a server that never bound.
log "Launching with codec=$CODEC"
xcrun devicectl device process launch \
  --device "$CAMERAMAN_DEVICE_UDID" \
  --console \
  --terminate-existing \
  --environment-variables "{\"codec\":\"$CODEC\"}" \
  "$CAMERAMAN_BUNDLE_ID" > "$CONSOLE" 2>&1 &
LAUNCH_PID=$!
trap 'kill $LAUNCH_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  grep -q '"isListening":true' "$CONSOLE" && break
  sleep 1
done
grep -q '"isListening":true' "$CONSOLE" || {
  tail -20 "$CONSOLE"
  fail "the app never reported a bound listener"
}

PORT="$(node -e '
  const fs = require("fs")
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").reverse()
  const line = lines.find((l) => /\{[^{}]*"isListening":true[^{}]*\}/.test(l))
  if (line === undefined) process.exit(1)
  const match = /\{[^{}]*"isListening":true[^{}]*\}/.exec(line)
  process.stdout.write(String(JSON.parse(match[0]).port))
' "$CONSOLE")"
log "Listening on $PORT"

# Resolved from Bonjour rather than hard-coded, which also proves the advertisement is usable.
HOST="${CAMERAMAN_HOST:-}"
if [ -z "$HOST" ]; then
  log "Resolving over Bonjour"
  HOST="$(node "$CAMERAMAN_ROOT/scripts/resolveCamera.js" 2>/dev/null)" \
    || fail "no camera answered on Bonjour — set CAMERAMAN_HOST to skip discovery"
fi
log "Camera at $HOST"

node "$CAMERAMAN_ROOT/scripts/rtspClient.js" \
  --host "$HOST" \
  --port "$PORT" \
  --path "live/mainstream" \
  --seconds "$STREAM_SECONDS" \
  --out "$VIDEO" \
  --audio-out "$AUDIO"

log "ffprobe on the received video:"
ffprobe -hide_banner -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,profile,width,height,pix_fmt \
  -of default=noprint_wrappers=1 \
  "$VIDEO"

# A stream can look plausible in its headers and still fail to decode, and a client that joins before
# a keyframe produces exactly that. Any decoder output at all is a failure here.
decodeCleanly() {
  local file="$1" label="$2" errors
  errors="$CAMERAMAN_DERIVED_DATA/decode-$label.log"
  ffmpeg -hide_banner -v error -i "$file" -f null - > "$errors" 2>&1 || {
    head -10 "$errors"
    fail "$label decode failed"
  }
  if [ -s "$errors" ]; then
    head -10 "$errors"
    fail "$label decoded with errors"
  fi
  log "$label decoded with no errors"
}

decodeCleanly "$VIDEO" "stream-video-$CODEC"
[ -s "$AUDIO" ] && decodeCleanly "$AUDIO" "stream-audio-$CODEC"

log "End-to-end $CODEC verified"
