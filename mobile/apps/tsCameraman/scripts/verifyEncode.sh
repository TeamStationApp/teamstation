#!/usr/bin/env bash
# Records the encoder's real output on the device, pulls it off, and decodes it with ffprobe.
#
# "The compression session accepted every property" and "the stream decodes" are different claims and
# only the second one matters. A VTCompressionSession that emits an undecodable stream reports no
# error anywhere, so the bytes have to be decoded by something that is not this app.
#
#   bash scripts/verifyEncode.sh hevc
#   RECORD_SECONDS=8 bash scripts/verifyEncode.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcrun
require ffprobe

CODEC="${CODEC:-h264}"
RECORD_SECONDS="${RECORD_SECONDS:-6}"

# Refuse what we don't understand rather than testing h264 and reporting success for it.
if [ $# -gt 1 ]; then
  fail "usage: verifyEncode.sh [h264|hevc]"
fi
if [ $# -eq 1 ]; then
  case "$1" in
    h264 | hevc) CODEC="$1" ;;
    *) fail "unknown codec '$1' (expected h264 or hevc)" ;;
  esac
fi
EXTENSION="h264"
[ "$CODEC" = "hevc" ] && EXTENSION="h265"

CONSOLE="$CAMERAMAN_DERIVED_DATA/verify-encode-$CODEC.log"
PULLED="$CAMERAMAN_DERIVED_DATA/encode-$CODEC.$EXTENSION"
mkdir -p "$CAMERAMAN_DERIVED_DATA"
rm -f "$PULLED"

log "Building and installing"
LAUNCH=0 bash "$CAMERAMAN_ROOT/scripts/build-device.sh" >/dev/null

log "Recording ${RECORD_SECONDS}s of $CODEC on the device"
set +e
timeout $((RECORD_SECONDS + 60)) xcrun devicectl device process launch \
  --device "$CAMERAMAN_DEVICE_UDID" \
  --console \
  --terminate-existing \
  "$CAMERAMAN_BUNDLE_ID" \
  -codec "$CODEC" -recordSeconds "$RECORD_SECONDS" > "$CONSOLE" 2>&1
set -e

summaryBetween() {
  node -e '
    const fs = require("fs")
    const text = fs.readFileSync(process.argv[1], "utf8")
    const marker = process.argv[2]
    const begin = text.indexOf(marker + "_BEGIN")
    const end = text.indexOf(marker + "_END")
    if (begin === -1 || end === -1) {
      console.error("the app printed no " + marker + " summary — see " + process.argv[1])
      process.exit(1)
    }
    process.stdout.write(text.slice(begin + (marker + "_BEGIN").length, end).trim())
  ' "$CONSOLE" "$1"
}

# The recorder writes into Documents, so the container-relative path is what `copy from` wants.
pull() {
  xcrun devicectl device copy from \
    --device "$CAMERAMAN_DEVICE_UDID" \
    --domain-type appDataContainer \
    --domain-identifier "$CAMERAMAN_BUNDLE_ID" \
    --source "Documents/$(basename "$1")" \
    --destination "$2" >/dev/null
  [ -s "$2" ] || fail "pulled $(basename "$1") is empty"
}

SUMMARY="$(summaryBetween CAMERAMAN_RECORDING)"
AUDIO_SUMMARY="$(summaryBetween CAMERAMAN_AUDIO_RECORDING)"

DEVICE_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).path)' "$SUMMARY")"
log "Device wrote $DEVICE_PATH"
pull "$DEVICE_PATH" "$PULLED"

log "ffprobe says:"
ffprobe -hide_banner -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,profile,width,height,pix_fmt,level \
  -show_entries format=duration,size,bit_rate \
  -of default=noprint_wrappers=1 \
  "$PULLED"

# A stream can report a plausible header and still fail to decode a single frame, so decode all of it
# and require ffmpeg to report no errors.
log "Decoding every frame"
DECODE_LOG="$CAMERAMAN_DERIVED_DATA/decode-$CODEC.log"
ffmpeg -hide_banner -v error -i "$PULLED" -f null - > "$DECODE_LOG" 2>&1 || {
  head -20 "$DECODE_LOG"
  fail "decode failed"
}
if [ -s "$DECODE_LOG" ]; then
  head -20 "$DECODE_LOG"
  fail "decode reported errors"
fi

FRAMES="$(ffprobe -hide_banner -v error -select_streams v:0 -count_frames \
  -show_entries stream=nb_read_frames -of csv=p=0 "$PULLED")"

log "Device summary: $SUMMARY"
log "Decoded $FRAMES video frames with no errors"

# Audio gets the same treatment. An AAC converter that produces garbage is just as silent about it.
AUDIO_DEVICE_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).path)' "$AUDIO_SUMMARY")"
AUDIO_PULLED="$CAMERAMAN_DERIVED_DATA/encode-audio.aac"
rm -f "$AUDIO_PULLED"
pull "$AUDIO_DEVICE_PATH" "$AUDIO_PULLED"

UNWRAPPABLE="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).unwrappable))' "$AUDIO_SUMMARY")"
[ "$UNWRAPPABLE" = "0" ] || fail "$UNWRAPPABLE audio frames could not be wrapped in ADTS"

log "ffprobe says about the audio:"
ffprobe -hide_banner -v error \
  -select_streams a:0 \
  -show_entries stream=codec_name,profile,sample_rate,channels \
  -of default=noprint_wrappers=1 \
  "$AUDIO_PULLED"

AUDIO_DECODE_LOG="$CAMERAMAN_DERIVED_DATA/decode-audio.log"
ffmpeg -hide_banner -v error -i "$AUDIO_PULLED" -f null - > "$AUDIO_DECODE_LOG" 2>&1 || {
  head -20 "$AUDIO_DECODE_LOG"
  fail "audio decode failed"
}
if [ -s "$AUDIO_DECODE_LOG" ]; then
  head -20 "$AUDIO_DECODE_LOG"
  fail "audio decode reported errors"
fi

log "Audio summary: $AUDIO_SUMMARY"
log "Audio decoded with no errors"
