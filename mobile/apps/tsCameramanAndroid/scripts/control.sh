#!/usr/bin/env bash
# Sends a command to the control channel and prints the reply.
#
#   bash scripts/control.sh dump-state
#   bash scripts/control.sh "set-zoom?displayed=4"
#
# Forwarded over adb rather than Wi-Fi so it works on a bench with no route to the handset. The app
# only listens when launched with `uiTest true`.
#
# `frameDelivery` goes over the stream's RTSP parameter port instead, forwarded the same way, and
# makes the camera drop captured frames before the encoder while staying connected:
#
#   bash scripts/control.sh frameDelivery 24         # a steady 24 fps
#   bash scripts/control.sh frameDelivery 24:60:20   # 24 up to 60 and back, every 20 s
#   bash scripts/control.sh frameDelivery off
#
# `struggle` makes a healthy phone starve like a hot one (mic loss, held sends, slow encoder), each
# part at its own level, from one seed so a run replays:
#
#   bash scripts/control.sh struggle 0.2:0.1:0.3:42  # mic:hold:slow:seed
#   bash scripts/control.sh struggle off
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require adb
require curl

TARGET="${1:-dump-state}"

if [ "$TARGET" = "frameDelivery" ] || [ "$TARGET" = "struggle" ]; then
  require node
  [ $# -ge 2 ] || fail "usage: control.sh frameDelivery <fps|low:high:period|wander:low:high:minHold:maxHold[:seed]|off> | struggle <mic:hold:slow[:seed]|off>"
  # The port the app bound when the control channel can say, the default when it cannot.
  forwardControl
  PORT="$(boundPort 2>/dev/null || echo 8554)"
  LOCAL="${CAMERAMAN_RTSP_FORWARD_PORT:-18554}"
  adb -s "$(resolveDevice)" forward "tcp:$LOCAL" "tcp:$PORT" >/dev/null
  exec node "$CAMERAMAN_IOS_SCRIPTS/control.js" --host 127.0.0.1 --rtsp-port "$LOCAL" "$TARGET" "$2"
fi

forwardControl
controlGet "/${TARGET#/}" | node -e '
  let body = ""
  process.stdin.on("data", chunk => { body += chunk })
  process.stdin.on("end", () => {
    try { console.log(JSON.stringify(JSON.parse(body), null, 2)) } catch { console.log(body) }
  })
'
