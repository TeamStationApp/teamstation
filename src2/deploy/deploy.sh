#!/usr/bin/env bash
set -euo pipefail

# GameStation 2.0: sync the deploy branch and rebuild.
#
#   ssh root@gamestation.co /srv/gamestation/repo/src2/deploy/deploy.sh
#
# Nothing is copied from a laptop. The previous way was an rsync of a built
# tree, which went wrong twice in the same way: `--delete` is needed so a
# removed file actually goes, and it then also removes anything the server has
# that the laptop does not — which on this box was a `scripts/` directory
# created in advance. Whatever is being deployed also depended on the state of
# whichever machine ran it. Here the server fetches a branch, builds it, and the
# only input is a commit.
#
# Each build lands in its own directory and `current` is moved to it at the end,
# so a half-built version is never the one running, and the previous one is
# still on disk to go back to. If the new one does not answer its health check
# it is put back automatically.
#
# Usage:
#   deploy.sh              deploy the tip of the deploy branch
#   deploy.sh <ref>        deploy a particular commit or tag
#   deploy.sh --rollback   go back to the previous version

# Run from a copy, before anything touches the clone.
#
# Bash reads a script as it executes it, a chunk at a time, keeping its place by
# byte offset. This script lives in the repository it is about to hard-reset, so
# updating the deploy script would rewrite this file underneath the running
# process and bash would carry on reading at the old offset into new bytes. The
# first time it mattered, the reset brought in a version that extracted an extra
# directory, the already-running copy did not have that line, and the deploy
# failed on a missing file that was sitting right there in the commit.
#
# Copying and re-execing costs nothing and makes the running script immutable
# for the rest of the run.
SELF_COPY=/tmp/gsDeploy.running.sh
if [ "${GS_DEPLOY_REEXEC:-}" != "1" ]; then
  install -m 0755 "$0" "$SELF_COPY"
  GS_DEPLOY_REEXEC=1 exec "$SELF_COPY" "$@"
fi

BRANCH="${GS_DEPLOY_BRANCH:-deploy}"
ROOT=/srv/gamestation
REPO="$ROOT/repo"
VERSIONS="$ROOT/versions"
CURRENT="$ROOT/current"
APP_USER=gamestation
SERVICE=gamestation
HEALTH=http://127.0.0.1:9100/api/v1/health
# How many builds to keep. Enough to go back more than once; six had piled up
# under the old way, because nothing ever removed them.
KEEP=5

export PATH="$ROOT/node-v24/bin:$PATH"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

# The version `current` points at now, so a failed deploy can go back to it.
previous_version() {
  [ -L "$CURRENT" ] && basename "$(readlink -f "$CURRENT")" || true
}

activate() {
  local version="$1"
  ln -sfn "$VERSIONS/$version" "$CURRENT.new"
  mv -Tf "$CURRENT.new" "$CURRENT"
  systemctl restart "$SERVICE"
}

# The service is up when it answers, not when systemd says it started: it forks
# workers and opens a database pool first, and a build that cannot reach the
# database starts perfectly well and serves nothing.
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

# ---- 1. Fetch ----------------------------------------------------------------

say "Fetching $BRANCH"
[ -d "$REPO/.git" ] || die "no clone at $REPO — see src2/deploy/README.md"
git -C "$REPO" fetch --prune --quiet origin
REF="${1:-origin/$BRANCH}"
git -C "$REPO" reset --hard --quiet "$REF"
# Anything untracked from an earlier build, so a stale file cannot be picked up.
# Safe here because the clone holds nothing but checked-out source.
git -C "$REPO" clean -fdq
SHA="$(git -C "$REPO" rev-parse --short HEAD)"
SUBJECT="$(git -C "$REPO" log -1 --pretty=%s)"
say "At $SHA — $SUBJECT"

# ---- 2. Build into a new directory -------------------------------------------

VERSION="$(node -p "require('$REPO/package.json').version")-$(date +%Y%m%d-%H%M%S)-$SHA"
TARGET="$VERSIONS/$VERSION"
[ -e "$TARGET" ] && die "$TARGET already exists"

say "Building $VERSION"
mkdir -p "$TARGET"
# Until the swap succeeds, this directory is rubbish if anything fails. Removing
# it keeps `versions/` holding only builds that ran, so --rollback cannot offer
# a half-built one.
trap 'rm -rf "${TARGET:?}"' ERR
# The source, without the git metadata or anything gitignored. No --delete,
# because the directory is new every time — which is the point.
#
# **The version directory is a copy of the repository, laid out the same way.**
# It used to be `src2`'s contents flattened to the top, which meant the package
# was built here against a tree that did not exist anywhere else, and the
# tsconfig one directory above the package — present in a checkout, absent
# here — silently stopped applying. Shipping the root configuration *with*
# `src2` is what stops that being possible again.
#
# `src/` is GameStation 1.0, frozen at `v1.0.0` and not part of this: naming
# what ships rather than excluding what does not means a new directory has to
# be asked for before it can reach the server.
git -C "$REPO" archive HEAD \
  package.json package-lock.json .npmrc \
  tsconfig.json tsconfig.app.json tsconfig.server.json \
  src2 |
  tar -x -C "$TARGET"

cd "$TARGET"
npm ci --no-audit --fund=false
npm run build        # tsc     src2/ → lib/
npm run build.web    # esbuild src2/ → dist/

# What is running, written where the server can read it. Without this the
# health endpoint reported a bare `0.1.0` and the only way to tell one deploy
# from the next was the hash in the app bundle's file name.
cat > "$TARGET/build.json" <<JSON
{"version": "$VERSION", "commit": "$SHA", "deployedAt": "$(date -Iseconds)"}
JSON

# The secrets live once, outside every version, and are symlinked in. A version
# directory can then be deleted without taking the configuration with it.
ln -sfn "$ROOT/serverConfig.json" "$TARGET/serverConfig.json"

chown -R "$APP_USER:$APP_USER" "$TARGET"

# ---- 3. Migrate --------------------------------------------------------------

# Before the swap, so the new code never meets a database it is ahead of. A
# migration that fails leaves `current` where it was, still serving.
say "Migrating"
sudo -u "$APP_USER" env "PATH=$PATH" npm run migrate -- up

# ---- 4. Swap, and go back if it does not answer ------------------------------

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
    healthy || die "$PREVIOUS is not answering either; the box needs a person"
    die "deploy failed and was rolled back to $PREVIOUS"
  fi
  die "$VERSION is not answering and there is nothing to go back to"
fi

# ---- 5. Prune ----------------------------------------------------------------

say "Keeping the newest $KEEP builds"
KEEPING="$(basename "$(readlink -f "$CURRENT")")"
ls -1 "$VERSIONS" | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  if [ "$old" = "$KEEPING" ]; then
    continue
  fi
  echo "  removing $old"
  rm -rf "${VERSIONS:?}/$old"
done

say "Deployed $VERSION ($SHA)"
