#!/usr/bin/env bash
set -euo pipefail

# TeamStation: deploy one development seat.
#
#   /srv/TeamStation_<name>/repo/src/deploy/deployWorktree.sh
#
# A seat is a branch, a worktree, a database and a service that all carry the
# same name — see the worktree-branch-database-naming rule. There is no seat
# number in here and no branch name either: **the script works out which seat
# it is from where it is running**, because it lives inside that seat's own
# worktree. Copying it somewhere else makes it that seat instead, which is the
# whole point. The predecessors of this script hard-coded a root, a service and
# a branch at the top, so deploying a second seat meant a second copy that
# drifted from the first.
#
#   branch     paul/<name>
#   worktree   /srv/TeamStation_<name>/repo
#   database   TeamStation_<name>      on the droplet's seats cluster, 5434
#   service    teamstation-<name>
#   port       whatever this seat's serverConfig.json says
#
# It migrates, which is the difference between a seat and production. That is
# safe only because the database belongs to this seat alone, and the guard
# below is what keeps it that way.

# Which seat this is, worked out from where the script lives:
#   /srv/TeamStation_<name>/repo/src/deploy/deployWorktree.sh
#
# Resolved *before* the re-exec below, and carried across in the environment,
# because the copy that actually runs lives in /tmp and could not answer the
# question from its own path.
if [ -z "${TS_SEAT_REPO:-}" ]; then
  # src/deploy -> src -> the worktree root.
  TS_SEAT_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  export TS_SEAT_REPO
fi

# The deploy replaces the very tree it is running from, so it runs from a copy.
SELF_COPY=/tmp/tsDeployWorktree.running.sh
if [ "${TS_DEPLOY_REEXEC:-}" != "1" ]; then
  install -m 0755 "$0" "$SELF_COPY"
  TS_DEPLOY_REEXEC=1 exec "$SELF_COPY" "$@"
fi

REPO="$TS_SEAT_REPO"
ROOT="$(dirname "$REPO")"
SEAT="$(basename "$ROOT")"
NAME="${SEAT#TeamStation_}"

BRANCH="paul/$NAME"
DB="TeamStation_$NAME"
SERVICE="teamstation-$NAME"
VERSIONS="$ROOT/versions"
CURRENT="$ROOT/current"
APP_USER=teamstation
KEEP=3

export PATH="/srv/teamstation/node-v24/bin:$PATH"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

[ "$SEAT" != "$NAME" ] || die "not a seat: $ROOT is not named TeamStation_<name>"

PORT="$(node -p "require('$ROOT/serverConfig.json').listenPort" 2>/dev/null || true)"
[ -n "$PORT" ] || die "no listenPort in $ROOT/serverConfig.json"
HEALTH="http://127.0.0.1:$PORT/api/v1/health"

previous_version() {
  [ -L "$CURRENT" ] && basename "$(readlink -f "$CURRENT")" || true
}

activate() {
  ln -sfn "$VERSIONS/$1" "$CURRENT.new"
  mv -Tf "$CURRENT.new" "$CURRENT"
  systemctl restart "$SERVICE"
}

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$HEALTH" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  mapfile -t all < <(ls -1 "$VERSIONS" | sort)
  current="$(previous_version)"
  target=""
  for v in "${all[@]}"; do
    [ "$v" = "$current" ] && break
    target="$v"
  done
  [ -n "$target" ] || die "no earlier version to go back to"
  say "Rolling back to $target"
  activate "$target"
  healthy && say "Back on $target" || die "$target is not answering either"
  exit 0
fi

say "Seat $SEAT — branch $BRANCH, database $DB, service $SERVICE, port $PORT"

# The one thing that must never be true: a seat pointed at a database that is
# not its own. It migrates, so a wrong `databaseUrl` is not a bad read, it is
# somebody else's schema rewritten by this branch.
#
# The **name** is checked, not just the port. An earlier version checked only
# for 5433, on the reasoning that production is 5432 so anything else was fair
# game. That stopped being true the afternoon a second seat was given its own
# database on the same cluster: a port check waves a deploy straight into it.
# The port says "not production"; only the name says "mine".
SEAT_DB="$(node -p "require('$ROOT/serverConfig.json').databaseUrl" 2>/dev/null || true)"
case "$SEAT_DB" in
  *:5433/"$DB"|*:5434/"$DB") ;;
  *) die "this seat's databaseUrl is not its own database:
${SEAT_DB:-<unset>}
It should name \`$DB\` on the seats cluster (5434; 5433 on a laptop). Production
is the managed cluster, and any other name is somebody else's schema. Fix the config; do not relax this check." ;;
esac

# The droplet's mirror of GitHub. Every clone on the box fetches from it, and it
# is refreshed here first so a deploy always builds the branch as GitHub has it. See
# src/deploy/README.md, "Where the code comes from".
refresh_mirror() {
  HOME=/root git -C /srv/teamstation.git fetch --prune --quiet origin ||
    die "could not refresh /srv/teamstation.git from GitHub (deploy key, network?)"
  chown -R teamstation:teamstation /srv/teamstation.git
}

say "Fetching $BRANCH"
refresh_mirror
git -C "$REPO" fetch --prune --quiet origin
git -C "$REPO" reset --hard --quiet "origin/$BRANCH"
git -C "$REPO" clean -fdq
SHA="$(git -C "$REPO" rev-parse --short HEAD)"
say "At $SHA — $(git -C "$REPO" log -1 --pretty=%s)"

VERSION="$(node -p "require('$REPO/package.json').version")-$(date +%Y%m%d-%H%M%S)-$SHA"
TARGET="$VERSIONS/$VERSION"
[ -e "$TARGET" ] && die "$TARGET already exists"

say "Building $VERSION"
mkdir -p "$TARGET"
trap 'rm -rf "${TARGET:?}"' ERR
git -C "$REPO" archive HEAD \
  package.json package-lock.json .npmrc \
  tsconfig.json tsconfig.app.json tsconfig.server.json \
  src |
  tar -x -C "$TARGET"
# The web build's esbuild settings, which `src/build.mjs` imports on any
# branch that has the scoring field. Asked of the tree rather than assumed,
# because a branch without the scoring field has no such file.
if git -C "$REPO" cat-file -e HEAD:scripts/web-build-settings.mjs 2>/dev/null; then
  git -C "$REPO" archive HEAD scripts/web-build-settings.mjs | tar -x -C "$TARGET"
fi

cd "$TARGET"
npm ci --no-audit --fund=false
npm run build
npm run build.web

cat > "$TARGET/build.json" <<JSON
{"version": "$VERSION", "commit": "$SHA", "deployedAt": "$(date -Iseconds)"}
JSON

ln -sfn "$ROOT/serverConfig.json" "$TARGET/serverConfig.json"
chown -R "$APP_USER:$APP_USER" "$TARGET"

# Before the swap, so the new code never meets a database it is ahead of. A
# migration that fails leaves `current` where it was, still serving.
say "Migrating $DB"
( cd "$TARGET" && sudo -u "$APP_USER" env "PATH=$PATH" npm run migrate -- up )

PREVIOUS="$(previous_version)"
say "Activating $VERSION"
activate "$VERSION"

if healthy; then
  trap - ERR
  say "Healthy: $(curl -fsS "$HEALTH")"
else
  if [ -n "$PREVIOUS" ]; then
    say "$VERSION is not answering — going back to $PREVIOUS"
    activate "$PREVIOUS"
    healthy || die "$PREVIOUS is not answering either"
    die "deploy failed and was rolled back to $PREVIOUS"
  fi
  die "$VERSION is not answering and there is nothing to go back to"
fi

say "Keeping the newest $KEEP builds"
KEEPING="$(basename "$(readlink -f "$CURRENT")")"
ls -1 "$VERSIONS" | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$KEEPING" ] && continue
  echo "  removing $old"
  rm -rf "${VERSIONS:?}/$old"
done

say "Deployed $VERSION ($SHA) to $SEAT"
