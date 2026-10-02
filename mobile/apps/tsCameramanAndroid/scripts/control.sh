#!/usr/bin/env bash
# Sends a command to the control channel and prints the reply.
#
#   bash scripts/control.sh dump-state
#   bash scripts/control.sh "set-zoom?displayed=4"
#
# Forwarded over adb rather than Wi-Fi so it works on a bench with no route to the handset. The app
# only listens when launched with `uiTest true`.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require adb
require curl

forwardControl
TARGET="${1:-dump-state}"
controlGet "/${TARGET#/}" | node -e '
  let body = ""
  process.stdin.on("data", chunk => { body += chunk })
  process.stdin.on("end", () => {
    try { console.log(JSON.stringify(JSON.parse(body), null, 2)) } catch { console.log(body) }
  })
'
