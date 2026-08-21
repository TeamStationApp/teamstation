#!/usr/bin/env bash
# Waits for the iPad to come back on USB, then keeps trying Maestro until UI automation is approved.
#
# Maestro needs a USB attachment for port forwarding, and enabling automation mode needs a human to
# approve it on the device. Neither can be arranged from here, so this polls instead of failing:
# whenever the device reappears, it retries, and the approval prompt is on screen when the user
# gets back to it.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

FLOW="${1:-smoke}"
DEADLINE=$(( $(date +%s) + 7200 ))
UDID="6569F691-DADE-5AD7-98D2-9B1A2D9765AC"

attached() {
  xcrun devicectl list devices 2>/dev/null | grep -q "$UDID.*connected"
}

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if attached; then
    echo "DEVICE ATTACHED — starting Maestro at $(date '+%H:%M:%S')"
    if node scripts/run-maestro.js "$FLOW" 2>&1 | tee /tmp/maestro-await.log | grep -qE "Flow passed|✓ Flow|status.*passed"; then
      echo "UI AUTOMATION APPROVED — flow ran"
      exit 0
    fi
    if grep -q "automation mode" /tmp/maestro-await.log 2>/dev/null; then
      echo "STILL WAITING FOR APPROVAL — enable Settings > Developer > Enable UI Automation"
    elif grep -q "not found" /tmp/maestro-await.log 2>/dev/null; then
      echo "device dropped mid-run, will retry"
    else
      echo "attempt finished without success, will retry"
    fi
    sleep 20
  else
    sleep 15
  fi
done

echo "gave up waiting after two hours"
exit 1
