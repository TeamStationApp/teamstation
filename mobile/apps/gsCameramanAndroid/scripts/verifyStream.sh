#!/usr/bin/env bash
# End-to-end check: build, run on the handset, pull the stream over RTSP with an independent client,
# and decode every frame with ffmpeg.
#
# The Node client in the iOS build's scripts/rtspClient.js is the judge here. It shares no code with
# either app, so it fails on anything that is not correct on the wire, and ffmpeg is then a third
# opinion on the bytes it collected.
#
#   bash scripts/verifyStream.sh hevc
#   STREAM_SECONDS=10 bash scripts/verifyStream.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require adb
require node
require ffprobe
require ffmpeg

CODEC="${CODEC:-h264}"
STREAM_SECONDS="${STREAM_SECONDS:-8}"

# Refuse what we don't understand rather than testing h264 and reporting success for it.
[ $# -le 1 ] || fail "usage: verifyStream.sh [h264|hevc]"
if [ $# -eq 1 ]; then
  case "$1" in
    h264 | hevc) CODEC="$1" ;;
    *) fail "unknown codec '$1' (expected h264 or hevc)" ;;
  esac
fi
EXTENSION="h264"
[ "$CODEC" = "hevc" ] && EXTENSION="h265"

mkdir -p "$CAMERAMAN_OUT"
VIDEO="$CAMERAMAN_OUT/stream-$CODEC.$EXTENSION"
AUDIO="$CAMERAMAN_OUT/stream-$CODEC.aac"
rm -f "$VIDEO" "$AUDIO"

bash "$CAMERAMAN_ROOT/scripts/install.sh"
bash "$CAMERAMAN_ROOT/scripts/launch.sh" uiTest true codec "$CODEC"

forwardControl
log "Waiting for the listener"
for _ in $(seq 1 30); do
  if controlGet /dump-state >/dev/null 2>&1; then break; fi
  sleep 1
done

PORT="$(boundPort)" || fail "the app never reported a bound listener"
HOST="${CAMERAMAN_HOST:-$(deviceAddress)}"
log "Camera at $HOST:$PORT"
# Not an aside: on Android this is *always* the fallback, because 554 is privileged.
[ "$PORT" = "554" ] || log "Serving on the fallback port — 554 is privileged on Android"

node "$CAMERAMAN_IOS_SCRIPTS/rtspClient.js" \
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
  errors="$CAMERAMAN_OUT/decode-$label.log"
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
