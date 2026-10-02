#!/usr/bin/env bash
# Checks TS Director's link server on the attached iPad, over the cable:
#   hello and the recordings list, a real take's manifest, timed fetches of its largest segment and
#   programme file, and that the listener is down while the Director is in the background and back
#   (same session, not a relaunch) when it returns. A webcam frame is taken at every step; read them.
#
#   DIRECTOR_DEVICE_UDID=<hardware udid> scripts/deviceLinkCheck.sh
#
# It sends the Director to the background by opening Settings. Check the Director is not recording
# before running it: a take stops when the app backgrounds without a live session to keep it alive.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

DEVICE="${DIRECTOR_DEVICE_UDID:?set DIRECTOR_DEVICE_UDID to the hardware UDID of the iPad}"
PORT=8770
PROBE_DIR="$DISTRIBUTOR_ROOT/tools/usbmuxProbe"
PROBE="$PROBE_DIR/.build/release/usbmuxProbe"
[ -x "$PROBE" ] || (cd "$PROBE_DIR" && swift build -c release >/dev/null)
WORK="$(mktemp -d)"
SHOTS="${SHOTS:-/tmp/ts-shots}"
CAMERA_URL='rtsps://192.168.7.1:7441/ExampleToken0001?enableSrtp'
mkdir -p "$SHOTS"

probe() { "$PROBE" "$@" --port "$PORT" --serial "$DEVICE"; }
body() { probe get "$1" | tail -n +2; }

frame() {
  ffmpeg -nostdin -loglevel error -rtsp_transport tcp -tls_verify 0 -timeout 15000000 \
    -i "$CAMERA_URL" -t 3 -c copy -y "$WORK/$1.mp4" &&
    ffmpeg -nostdin -loglevel error -i "$WORK/$1.mp4" -ss 2 -frames:v 1 -y "$SHOTS/link-$1.png" &&
    log "webcam frame: $SHOTS/link-$1.png" || log "webcam frame $1 failed"
}

log "Hello"
# A Director launched a moment ago is still starting; give its listener half a minute.
for _ in $(seq 1 30); do
  if body /v1/hello > "$WORK/hello.json" 2>/dev/null && [ -s "$WORK/hello.json" ]; then break; fi
  sleep 1
done
[ -s "$WORK/hello.json" ] || fail "TS Director did not answer on port $PORT: is it open and in front?"
cat "$WORK/hello.json"
echo
SESSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).sessionID)' "$WORK/hello.json")"
frame hello

log "Recordings"
body /v1/recordings > "$WORK/recordings.json"
read -r ID SOURCE <<<"$(node -e '
  const all = JSON.parse(require("fs").readFileSync(process.argv[1]));
  const pick = all.filter(r => !r.isLive && r.hasPrimary && r.cameras.length).sort((a, b) => b.id - a.id)[0];
  if (!pick) { console.log("none none"); process.exit(0); }
  console.log(pick.id, pick.cameras[0].sourceID.rawValue);
  console.error(`${all.length} recordings; using ${pick.id}: ${pick.cameras.map(c => `${c.name} ${(c.bytes / 1e9).toFixed(2)} GB`).join(", ")}`);
' "$WORK/recordings.json")"
[ "$ID" != "none" ] || fail "no finished recording with a primary output and a camera to fetch from"

log "Manifest for recording $ID"
body "/v1/recordings/$ID/manifest?tracks=primary,camera:$SOURCE" > "$WORK/manifest.json"
# A read loop rather than `mapfile`, which the bash macOS ships (3.2) does not have.
FILES=()
while IFS= read -r line; do FILES+=("$line"); done < <(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1]));
  console.error(`window ${m.window.start.seconds}..${m.window.end ? m.window.end.seconds : "open"}, ${m.manifest.segments.length} segments, ${m.files.length} files`);
  const largest = root => m.files.filter(f => f.root === root).sort((a, b) => b.bytes - a.bytes)[0];
  for (const f of [ largest("archives"), largest("program") ].filter(Boolean)) {
    console.log(`/v1/files/${f.root}/${f.path.split("/").map(encodeURIComponent).join("/")}`);
  }
' "$WORK/manifest.json")

for file in "${FILES[@]}"; do
  log "Fetch $file"
  probe fetch "$file"
done
frame fetched

log "Sending TS Director to the background"
xcrun devicectl device process launch --device "$DEVICE" com.apple.Preferences >/dev/null
DOWN=0
for _ in $(seq 1 20); do
  if ! probe get /v1/hello >/dev/null 2>&1; then DOWN=1; break; fi
  sleep 1
done
frame background
[ $DOWN -eq 1 ] && log "Listener is down in the background" || fail "the listener still answered with the Director in the background"

log "Bringing TS Director back"
xcrun devicectl device process launch --device "$DEVICE" app.teamstation.director >/dev/null
UP=0
for _ in $(seq 1 30); do
  if body /v1/hello > "$WORK/hello-again.json" 2>/dev/null && [ -s "$WORK/hello-again.json" ]; then UP=1; break; fi
  sleep 1
done
frame foreground
[ $UP -eq 1 ] || fail "the listener did not come back"
AGAIN="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).sessionID)' "$WORK/hello-again.json")"
if [ "$AGAIN" = "$SESSION" ]; then
  log "Listener is back, same session $SESSION: the Director resumed rather than relaunched"
else
  log "Listener is back with a new session ($SESSION -> $AGAIN): the Director was relaunched"
fi

rm -rf "$WORK"
log "Link check done"
