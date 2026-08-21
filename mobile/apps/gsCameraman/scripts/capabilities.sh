#!/usr/bin/env bash
# Measures this handset's camera capability set and writes it to docs/capabilities.json.
#
# The app prints the measurement to stdout between two markers, and `devicectl ... --console`
# streams that back over the tunnel. This is the only way to get the numbers: whether a format keeps
# multi-lens switching cannot be read off a format object, it has to be made active and the device's
# switchover factors read back.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcrun
OUT="${OUT:-$CAMERAMAN_ROOT/docs/capabilities.json}"
CONSOLE="$CAMERAMAN_DERIVED_DATA/capabilities-console.log"
mkdir -p "$CAMERAMAN_DERIVED_DATA" "$(dirname "$OUT")"

log "Building and installing without launching"
LAUNCH=0 bash "$CAMERAMAN_ROOT/scripts/build-device.sh" >/dev/null

# The measurement blocks on the camera and microphone prompts, so on a device that has not granted
# them yet this has to happen first. It cannot happen after the console launch: maestro-runner
# terminates the app before every flow, which kills the console session with signal 9. Once granted,
# the permissions persist and this step is a no-op.
if command -v maestro-runner >/dev/null 2>&1; then
  log "Granting permissions"
  GRANT="$CAMERAMAN_DERIVED_DATA/grant-permissions.yaml"
  {
    echo "appId: $CAMERAMAN_BUNDLE_ID"
    echo "---"
    echo "- launchApp"
    echo "- waitForAnimationToEnd:"
    echo "    timeout: 4000"
    cat "$CAMERAMAN_ROOT/maestro/flows/shared/allow-permissions.yaml" | tail -n +3
  } > "$GRANT"
  maestro-runner --platform ios \
    --team-id "$CAMERAMAN_TEAM_ID" \
    --device "$CAMERAMAN_DEVICE_UDID" \
    --driver-start-timeout 600 \
    "$GRANT" >/dev/null 2>&1 || warn "permission flow did not complete cleanly"
else
  warn "maestro-runner not on PATH — the measurement will hang if permissions are not yet granted"
fi

log "Launching with a console attached"
# The app keeps running after it prints, so the read has to be bounded. A non-zero exit from
# `timeout` here is expected and is not a failure.
set +e
# `-measureCapabilities` runs the measurement instead of the camera. Without it the app opens the
# live session and never prints anything, so the read would time out with no explanation.
timeout "${CONSOLE_TIMEOUT:-180}" xcrun devicectl device process launch \
  --device "$CAMERAMAN_DEVICE_UDID" \
  --console \
  --terminate-existing \
  "$CAMERAMAN_BUNDLE_ID" -measureCapabilities true > "$CONSOLE" 2>&1
set -e

node -e '
  const fs = require("fs")
  const text = fs.readFileSync(process.argv[1], "utf8")
  const begin = text.indexOf("CAMERAMAN_CAPABILITIES_BEGIN")
  const end = text.indexOf("CAMERAMAN_CAPABILITIES_END")
  if (begin === -1 || end === -1 || end < begin) {
    console.error("no capability block in the console output")
    process.exit(1)
  }
  const body = text.slice(begin + "CAMERAMAN_CAPABILITIES_BEGIN".length, end)
  // devicectl prefixes each streamed line with a timestamp and the process name, so the JSON has to
  // be reassembled from the part of each line after that prefix.
  const cleaned = body
    .split("\n")
    .map(line => line.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\S+\s+/, ""))
    .join("\n")
    .trim()
  const parsed = JSON.parse(cleaned)
  fs.writeFileSync(process.argv[2], JSON.stringify(parsed, null, 2) + "\n")
  const devices = parsed.devices ?? []
  console.log(`model ${parsed.modelIdentifier} iOS ${parsed.systemVersion}`)
  for (const device of devices) {
    const multi = device.formats.filter(f => f.keepsMultiLensSwitching).length
    console.log(
      `  ${device.position} ${device.deviceType}: ${device.formats.length} formats, ` +
      `${multi} keep lens switching, zoom ${device.minAvailableZoom}-${device.maxAvailableZoom} ` +
      `x${device.displayZoomMultiplier}, switchovers [${device.switchOverZoomFactors.join(", ")}]`
    )
  }
  console.log(`  ports ${JSON.stringify(parsed.portBindings)}`)
' "$CONSOLE" "$OUT"

log "Wrote $OUT"
