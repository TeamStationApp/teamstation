#!/usr/bin/env bash
set -euo pipefail

# TeamStation: make a fresh Ubuntu 24.04 droplet into app.teamstation.app.
#
#   provision.sh <ffmpeg directory>
#
# Run as root, from a clone of the repository (the Caddyfile is installed from
# beside this script). Safe to run again: every step checks before it acts.
#
# What is NOT on the droplet: production's Postgres and Redis. Those are the
# managed clusters app-teamstation-app--postgres and app-teamstation-app--redis,
# reached on their private hosts. The local Postgres holds only the disposable
# seat databases, on the `seats` cluster at 5434.
#
#   /mnt/datadrive              the 50 GB volume app-teamstation-app--volume
#     work/                     scratch: remuxes, and a frame while its still
#                               is cut (stills themselves live in the Space)
#     uploads/                  Director uploads while their parts arrive
#     media/                    live recordings until they reach the Space
#     app/                      builds for direct download: builds/,
#                               downloads/ and install/
#   /srv/teamstation            repo/ versions/ current, node-v24/, ffmpeg,
#                               serverConfig.json, do-ca.crt
#   /srv/teamstation.git        the bare repository deploys push to
#   /srv/develop1–4             the seat symlinks Caddy serves

FFMPEG_SOURCE="${1:-}"
[ -n "$FFMPEG_SOURCE" ] || {
  echo "usage: provision.sh <ffmpeg directory>" >&2
  exit 2
}
[ "$(id -u)" = 0 ] || {
  echo "provision.sh runs as root" >&2
  exit 2
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=/srv/teamstation
DATA=/mnt/datadrive
APP_USER=teamstation
NODE_VERSION=24.14.0
PG=18

say() { printf '\n== %s\n' "$*"; }

say "The volume at $DATA"
mountpoint -q "$DATA" || {
  echo "$DATA is not mounted: attach app-teamstation-app--volume first" >&2
  exit 1
}

say "Packages"
export DEBIAN_FRONTEND=noninteractive
if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
    >/etc/apt/sources.list.d/pgdg.list
fi
if [ ! -f /etc/apt/sources.list.d/caddy-stable.list ]; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    >/etc/apt/sources.list.d/caddy-stable.list
fi
apt-get update -q
apt-get install -y -q "postgresql-$PG" "postgresql-client-$PG" caddy \
  redis-tools socat rsync git curl jq

say "The seats cluster on 5434"
# The package makes a `main` cluster on 5432. Production is not here, so it
# goes; the seat databases get a cluster of their own.
if pg_lsclusters -h | awk '{print $2}' | grep -qx main; then
  pg_dropcluster --stop "$PG" main
fi
if ! pg_lsclusters -h | awk '{print $2}' | grep -qx seats; then
  pg_createcluster "$PG" seats --port 5434 --start
fi
systemctl enable --now "postgresql@$PG-seats"

say "The $APP_USER user and directories"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
sudo -u postgres psql -p 5434 -tAc "select 1 from pg_roles where rolname = '$APP_USER'" |
  grep -q 1 || sudo -u postgres createuser -p 5434 --createdb "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$ROOT" "$ROOT/versions" \
  "$DATA/work" "$DATA/uploads" "$DATA/media" \
  "$DATA/app" "$DATA/app/builds" "$DATA/app/downloads" "$DATA/app/install"
for n in 1 2 3 4; do install -d -o "$APP_USER" -g "$APP_USER" "/srv/develop$n"; done

say "Node $NODE_VERSION"
if [ ! -x "$ROOT/node-v24/bin/node" ] ||
  [ "$("$ROOT/node-v24/bin/node" -v)" != "v$NODE_VERSION" ]; then
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "/tmp/$tarball"
  rm -rf "$ROOT/node-v24"
  install -d "$ROOT/node-v24"
  tar -xJf "/tmp/$tarball" -C "$ROOT/node-v24" --strip-components=1
  rm "/tmp/$tarball"
fi

say "ffmpeg from $FFMPEG_SOURCE"
target="$ROOT/$(basename "$FFMPEG_SOURCE")"
[ -d "$target" ] || cp -a "$FFMPEG_SOURCE" "$target"

say "The bare repository"
[ -d /srv/teamstation.git ] || git init --bare --initial-branch=master /srv/teamstation.git
chown -R "$APP_USER:$APP_USER" /srv/teamstation.git

say "The teamstation service"
install -m 0644 "$HERE/teamstation.service" /etc/systemd/system/teamstation.service
systemctl daemon-reload
systemctl enable teamstation

say "Caddy"
install -d -o caddy -g caddy /var/log/caddy
install -m 0644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# Validating as root opens the log files as root; Caddy runs as caddy.
chown -R caddy:caddy /var/log/caddy
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

say "Provisioned. Next: serverConfig.json and do-ca.crt in $ROOT, then src/deploy/deploy.sh"
