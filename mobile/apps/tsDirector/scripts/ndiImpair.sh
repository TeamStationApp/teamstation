#!/usr/bin/env bash
# Network impairment for the NDI runs, below NDI's own error correction.
#
# The generator's own faults (drop, burst, stall, jitter) simulate a camera behaving badly. They
# cannot simulate a bad *network*, because NDI 5 and later carry video over a reliable UDP protocol
# with retransmission and congestion control: loss on the wire is repaired before a receiver ever
# sees it. The only way to exercise that machinery — and to find out what it costs when it is
# working hard — is to damage the link underneath it, which is what this does.
#
#   sudo bash scripts/ndiImpair.sh --loss 2 --delay 40 --jitter 20 --bandwidth 20Mbit
#   sudo bash scripts/ndiImpair.sh --off
#
# Simulator runs go over loopback, so `lo0` is the default interface; pass --interface en0 for a
# physical iPad on the LAN.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

PIPE=1
INTERFACE="lo0"
LOSS=""
DELAY=""
JITTER=""
BANDWIDTH=""
OFF=0

while [ $# -gt 0 ]; do
  case "$1" in
    --loss) LOSS="$2"; shift 2 ;;
    --delay) DELAY="$2"; shift 2 ;;
    --jitter) JITTER="$2"; shift 2 ;;
    --bandwidth) BANDWIDTH="$2"; shift 2 ;;
    --interface) INTERFACE="$2"; shift 2 ;;
    --off) OFF=1; shift ;;
    --help|-h)
      cat <<'USAGE'
Usage: sudo bash scripts/ndiImpair.sh [--loss PERCENT] [--delay MS] [--jitter MS]
                                      [--bandwidth RATE] [--interface IF] [--off]

  --loss       Percentage of packets to drop, e.g. 2
  --delay      One-way delay in milliseconds
  --jitter     Random extra delay up to this many milliseconds
  --bandwidth  Cap, in dummynet notation, e.g. 20Mbit
  --interface  Default lo0, which is what a simulator run uses; en0 for an iPad on the LAN
  --off        Remove every rule this script installed
USAGE
      exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "run this with sudo: dnctl and pfctl both need root"

ANCHOR="ts-ndi-impair"
RULES="/tmp/${ANCHOR}.conf"

if [ "$OFF" -eq 1 ]; then
  dnctl -q flush 2>/dev/null || true
  pfctl -a "$ANCHOR" -F all 2>/dev/null || true
  # Leaving pf enabled when it was off before this ran would silently change the machine's
  # firewalling for everything else.
  pfctl -d 2>/dev/null || true
  rm -f "$RULES"
  log "impairment removed from $INTERFACE"
  exit 0
fi

PIPE_ARGS=""
[ -n "$BANDWIDTH" ] && PIPE_ARGS="$PIPE_ARGS bw $BANDWIDTH"
[ -n "$DELAY" ] && PIPE_ARGS="$PIPE_ARGS delay $DELAY"
[ -n "$LOSS" ] && PIPE_ARGS="$PIPE_ARGS plr $(node -e 'console.log(Number(process.argv[1]) / 100)' "$LOSS")"
# dummynet expresses jitter as a delay range rather than a separate figure.
[ -n "$JITTER" ] && PIPE_ARGS="$PIPE_ARGS delay $(( ${DELAY:-0} + ${JITTER} ))"
[ -n "$PIPE_ARGS" ] || fail "nothing to do: pass at least one of --loss --delay --jitter --bandwidth"

log "pipe $PIPE:$PIPE_ARGS on $INTERFACE"
dnctl -q flush
# shellcheck disable=SC2086
dnctl pipe "$PIPE" config $PIPE_ARGS

# NDI's discovery and media both ride UDP; TCP is used for the initial connection, so both are
# impaired. Restricting this to the NDI port range would miss the dynamically allocated ones.
cat > "$RULES" <<RULES
dummynet in on $INTERFACE all pipe $PIPE
dummynet out on $INTERFACE all pipe $PIPE
RULES

pfctl -a "$ANCHOR" -f "$RULES"
pfctl -E 2>/dev/null || pfctl -e 2>/dev/null || true
log "impairment active; remove it with: sudo bash scripts/ndiImpair.sh --off"
