#!/usr/bin/env bash
set -euo pipefail

# TeamStation: the *second* development clone, beside production
# and the first one on the same box.
#
#   ssh root@app.teamstation.app /srv/teamstation-dev/repo/src/deploy/deployDev2.sh
#
# Same shape as deploy.sh — fetch a branch, build it into its own directory,
# swap a symlink, health-check, go back if it does not answer — with three
# differences that matter:
#
#   1. It answers on 9300 — production has 9100, the first development clone
#      has 9200 — so none of the three can take another's port by accident.
#   2. **It never migrates.** The development clone reads and writes the
#      production database, so a migration run from here would alter what the
#      live site is serving. A branch that needs one is not a branch this
#      script can deploy; it says so and stops.
#   3. It takes its branch from the command line, defaulting to the branch
#      being developed rather than to `deploy`.
#
# The address this clone answers on is not set here and is not in the branch.
# It is `primaryUrlOverride` in this clone's own `serverConfig.json`, which
# says develop2.teamstation.app — so a branch deployed here changes no tracked
# file, and nothing has to be put back before it lands.

SELF_COPY=/tmp/tsDeployDev2.running.sh
if [ "${TS_DEPLOY_REEXEC:-}" != "1" ]; then
  install -m 0755 "$0" "$SELF_COPY"
  TS_DEPLOY_REEXEC=1 exec "$SELF_COPY" "$@"
fi

BRANCH="${TS_DEV_BRANCH:-paul/mobileApp}"
ROOT=/srv/teamstation-dev2
REPO="$ROOT/repo"
VERSIONS="$ROOT/versions"
CURRENT="$ROOT/current"
APP_USER=teamstation
SERVICE=teamstation-dev2
HEALTH=http://127.0.0.1:9300/api/v1/health
KEEP=3

export PATH="/srv/teamstation/node-v24/bin:$PATH"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

previous_version() {
  [ -L "$CURRENT" ] && basename "$(readlink -f "$CURRENT")" || true
}

activate() {
  local version="$1"
  ln -sfn "$VERSIONS/$version" "$CURRENT.new"
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

# The droplet's mirror of GitHub. Every clone on the box fetches from it, and it
# is refreshed here first so a deploy always builds the branch as GitHub has it. See
# src/deploy/README.md, "Where the code comes from".
refresh_mirror() {
  HOME=/root git -C /srv/teamstation.git fetch --prune --quiet origin ||
    die "could not refresh /srv/teamstation.git from GitHub (deploy key, network?)"
  chown -R teamstation:teamstation /srv/teamstation.git
}

say "Fetching $BRANCH"
[ -d "$REPO/.git" ] || die "no clone at $REPO"
refresh_mirror
git -C "$REPO" fetch --prune --quiet origin
REF="${1:-origin/$BRANCH}"
git -C "$REPO" reset --hard --quiet "$REF"
git -C "$REPO" clean -fdq
SHA="$(git -C "$REPO" rev-parse --short HEAD)"
say "At $SHA — $(git -C "$REPO" log -1 --pretty=%s)"

# The production clone is the yardstick for what the live database has already
# had done to it. A branch carrying a migration production has not seen would
# change the live site's schema the moment this ran, so it stops instead.
PROD_MIGRATIONS="$(ls -1 /srv/teamstation/repo/src/migrate/migrations | sort)"
DEV_MIGRATIONS="$(ls -1 "$REPO/src/migrate/migrations" | sort)"
EXTRA="$(comm -13 <(echo "$PROD_MIGRATIONS") <(echo "$DEV_MIGRATIONS"))"
[ -z "$EXTRA" ] || die "this branch adds migrations the live database has not seen:
$EXTRA
The development clone shares the production database. Deploy them through the
normal path, or give this clone a database of its own."

VERSION="$(node -p "require('$REPO/package.json').version")-$(date +%Y%m%d-%H%M%S)-$SHA"
TARGET="$VERSIONS/$VERSION"
[ -e "$TARGET" ] && die "$TARGET already exists"

say "Building $VERSION"
mkdir -p "$TARGET"
trap 'rm -rf "${TARGET:?}"' ERR
# The same shape as deploy.sh: the version directory is a copy of the
# repository, so the configuration the package is built against is the
# configuration in the tree.
git -C "$REPO" archive HEAD \
  package.json package-lock.json .npmrc \
  tsconfig.json tsconfig.app.json tsconfig.server.json \
  src |
  tar -x -C "$TARGET"

cd "$TARGET"
npm ci --no-audit --fund=false
npm run build
npm run build.web

cat > "$TARGET/build.json" <<JSON
{"version": "$VERSION", "commit": "$SHA", "deployedAt": "$(date -Iseconds)"}
JSON

ln -sfn "$ROOT/serverConfig.json" "$TARGET/serverConfig.json"
chown -R "$APP_USER:$APP_USER" "$TARGET"

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

say "Deployed $VERSION ($SHA) to develop2.teamstation.app"
