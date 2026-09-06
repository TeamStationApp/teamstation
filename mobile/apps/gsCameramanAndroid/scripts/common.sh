# Shared settings for the GS Cameraman Android scripts.
#
# Sourced, not run. Everything here is derived rather than typed twice: a script that hardcodes the
# port would keep working after the app moved to the fallback and would then test nothing.
set -euo pipefail

CAMERAMAN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAMERAMAN_PACKAGE="co.gamestation.cameraman"
CAMERAMAN_ACTIVITY="$CAMERAMAN_PACKAGE/.MainActivity"
CAMERAMAN_CONTROL_PORT="${CAMERAMAN_CONTROL_PORT:-8766}"
CAMERAMAN_OUT="${CAMERAMAN_OUT:-$CAMERAMAN_ROOT/build/verify}"

# The iOS build's helpers are reused rather than reimplemented. `rtspClient.js` shares no code with
# either app, which is exactly what makes it a judge: it fails on anything that is not correct on
# the wire, whichever platform produced it.
CAMERAMAN_IOS_SCRIPTS="$CAMERAMAN_ROOT/../gsCameraman/scripts"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not on PATH"
}

# The serial of the handset to drive. ANDROID_SERIAL wins; otherwise the only attached device does,
# and two attached devices is an error rather than a coin flip.
resolveDevice() {
  if [ -n "${ANDROID_SERIAL:-}" ]; then
    echo "$ANDROID_SERIAL"
    return
  fi
  local devices
  devices="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
  local count
  count="$(printf '%s\n' "$devices" | grep -c . || true)"
  [ "$count" -eq 1 ] || fail "expected exactly one attached device, found $count — set ANDROID_SERIAL"
  printf '%s' "$devices"
}

# The port the app actually bound, read from the app rather than assumed. On Android this is never
# 554: Linux refuses a privileged port to an unprivileged process, so the app always falls through
# to its fallback and a script that assumed otherwise would connect to nothing.
boundPort() {
  controlGet /dump-state | node -e '
    let body = ""
    process.stdin.on("data", chunk => { body += chunk })
    process.stdin.on("end", () => {
      const port = JSON.parse(body).server.port
      if (!port) { process.exit(1) }
      process.stdout.write(String(port))
    })
  '
}

deviceAddress() {
  controlGet /dump-state | node -e '
    let body = ""
    process.stdin.on("data", chunk => { body += chunk })
    process.stdin.on("end", () => {
      const url = JSON.parse(body).streamURL
      process.stdout.write(new URL(url.replace("rtsp://", "http://")).hostname)
    })
  '
}

# The control channel over `adb forward`, so it works with no Wi-Fi route to the handset at all.
forwardControl() {
  adb -s "$(resolveDevice)" forward "tcp:$CAMERAMAN_CONTROL_PORT" "tcp:$CAMERAMAN_CONTROL_PORT" >/dev/null
}

controlGet() {
  curl -fsS --max-time 5 "http://127.0.0.1:$CAMERAMAN_CONTROL_PORT$1"
}
