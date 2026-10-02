#!/usr/bin/env bash
# Starts a run of the chat end-to-end scenarios from nothing, on this Mac.
#
#   scripts/chat-e2e-reset.sh <artifacts dir>
#
# Drops and recreates the branch's development database, migrates it, builds
# the chat fixture into it (`npm run chat-seed`, whose table of people and
# passwords is kept as <artifacts>/seed.txt), and empties
# <artifacts>/profiles/, where each browser device keeps its keys.
#
# The database is the one the local serverConfig.json names, and nothing else:
# its databaseUrl must be on localhost, so this can never drop a database
# anywhere but here. A running API keeps going; its connections are cut and
# it reconnects.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <artifacts dir>" >&2
  exit 2
fi
artifacts=$1
cd "$(dirname "$0")/.."

url=$(node -e "console.log(require('./serverConfig.json').databaseUrl)")
case "$url" in
  postgres://localhost:* | postgres://127.0.0.1:* | postgresql://localhost:* | postgresql://127.0.0.1:*) ;;
  *)
    echo "serverConfig.json's databaseUrl is not on this Mac: $url" >&2
    exit 1
    ;;
esac
rest=${url#*://*:}
port=${rest%%/*}
name=${rest#*/}
name=${name%%\?*}

echo "Recreating $name on port $port"
dropdb -h localhost -p "$port" --if-exists --force "$name"
createdb -h localhost -p "$port" "$name"
npm run --silent migrate -- up
mkdir -p "$artifacts"
npm run --silent chat-seed | tee "$artifacts/seed.txt"
rm -rf "$artifacts/profiles"
mkdir -p "$artifacts/profiles"
echo "Ready: $name seeded, $artifacts/profiles emptied"
