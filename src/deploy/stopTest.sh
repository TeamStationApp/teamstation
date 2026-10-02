#!/usr/bin/env bash
# How long does the server take to stop when a worker will not co-operate?
#
#   src/deploy/stopTest.sh
#
# Every second this takes is a second of 502s during a deploy, because the port
# is held until the old process is gone. On 2026-09-17 a worker wedged and the
# primary waited on it until systemd's ninety-second TimeoutStopSec expired and
# SIGKILLed the pair; somebody trying to sign in during that window got a 502
# and no explanation.
#
# SIGSTOP stands in for the wedge — a worker stuck in a syscall, a database
# close that never returns, a request that never finishes. A stopped process
# cannot run its SIGTERM handler, which is precisely the case that used to hang
# for ever, and is the only part of this that needed contriving.
#
# Expect a healthy stop well under a second, and a wedged one bounded by
# FORCE_STOP_MS in server/index.ts.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

node -r sucrase/register server/index.ts >/tmp/gsStopTest.log 2>&1 &
MAIN=$!

for _ in $(seq 1 40); do
  curl -s -o /dev/null --max-time 1 http://127.0.0.1:9100/api/v1/health && break
  sleep 0.5
done
sleep 1

VICTIM=$(pgrep -P "$MAIN" | head -1)
if [ -n "${VICTIM:-}" ]; then
  kill -STOP "$VICTIM" 2>/dev/null && echo "  wedged worker $VICTIM (SIGSTOP)"
else
  echo "  no worker to wedge — is clusterWorkers 1? testing the plain stop"
fi

START=$(date +%s)
kill -TERM "$MAIN" 2>/dev/null
for _ in $(seq 1 120); do
  kill -0 "$MAIN" 2>/dev/null || break
  sleep 0.5
done
END=$(date +%s)

if kill -0 "$MAIN" 2>/dev/null; then
  echo "  PRIMARY STILL RUNNING after 60s — this is the hang"
  kill -9 "$MAIN" 2>/dev/null
  STATUS=1
else
  echo "  primary exited after about $((END - START))s"
  STATUS=0
fi

[ -n "${VICTIM:-}" ] && { kill -CONT "$VICTIM" 2>/dev/null; kill -9 "$VICTIM" 2>/dev/null; }
wait 2>/dev/null
grep -iE "SIGTERM|forcing" /tmp/gsStopTest.log | sed 's/^/     /'
exit $STATUS
