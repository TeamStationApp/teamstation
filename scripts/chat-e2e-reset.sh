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
# Every seeded person is confirmed for chat (as if they had agreed to the age
# sheet), except the keys in TS_CHAT_SEED_UNCONFIRMED (comma-separated, e.g.
# TS_CHAT_SEED_UNCONFIRMED=C), which the seed passes through.
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
# This machine's database only, with or without a user name.
if ! printf '%s' "$url" | grep -Eq '^postgres(ql)?://([A-Za-z0-9_]+@)?(localhost|127\.0\.0\.1):[0-9]+/'; then
  echo "serverConfig.json's databaseUrl is not on this machine: $url" >&2
  exit 1
fi
rest=${url#*://*:}
port=${rest%%/*}
name=${rest#*/}
name=${name%%\?*}

echo "Recreating $name on port $port"
# The URL's user, when it names one; otherwise this account's own role.
user=()
case "$url" in
  *://*@*) login=${url#*://}; user=(-U "${login%%@*}") ;;
esac
dropdb -h localhost -p "$port" ${user[@]+"${user[@]}"} --if-exists --force "$name"
createdb -h localhost -p "$port" ${user[@]+"${user[@]}"} "$name"
npm run --silent migrate -- up
mkdir -p "$artifacts"
npm run --silent chat-seed | tee "$artifacts/seed.txt"
rm -rf "$artifacts/profiles"
mkdir -p "$artifacts/profiles"
echo "Ready: $name seeded, $artifacts/profiles emptied"
