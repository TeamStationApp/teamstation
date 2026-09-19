# Deploying GameStation 2.0

The server fetches a branch and builds it. Nothing is copied from a laptop, so
a deploy depends on a commit and not on the state of whoever ran it.

```sh
ssh root@gamestation.co /srv/gamestation/repo/src2/deploy/deploy.sh
```

## The deploy branch

**`deploy` is what the server follows, and it is whatever is on the server.**
Moving it is the act of deploying:

```sh
git push --force-with-lease origin <your-branch>:deploy
ssh root@gamestation.co /srv/gamestation/repo/src2/deploy/deploy.sh
```

Keeping it separate from the working branch means a push to the branch you are
working on is not a release, and the commit that is live can always be read off
one ref.

### One server, so one agent at a time

There is a single box, so `deploy` is a single seat. An agent takes it to try
something on real data before merging to master, and while it holds the seat
nobody else pushes to `deploy` — a second agent doing so silently replaces
what the first is testing, and neither of them sees it happen.

So `deploy` is force-pushed, not fast-forwarded: it follows one branch at a
time rather than accumulating everybody's. **Ask Paul who holds it before
pushing.** The commit that is live is the answer to who had it last:

```sh
ssh root@gamestation.co git -C /srv/gamestation/repo log --oneline -1
```

## What a deploy does

1. Fetches and hard-resets the clone at `/srv/gamestation/repo` to the branch.
2. Builds into a **new** `/srv/gamestation/versions/<version>-<date>-<sha>`.
3. Symlinks `serverConfig.json` in from `/srv/gamestation/`, which is the only
   copy and is never inside a version.
4. Runs migrations, before the swap, so the new code never meets a database it
   is ahead of.
5. Moves the `current` symlink and restarts the service.
6. Waits for `/api/v1/health` to answer. **If it does not, `current` goes back
   to the previous version automatically** and the deploy fails loudly.
7. Removes all but the newest five builds.

## Caddy must not cache a playlist

`/media/*` is served by Caddy, and everything under it used to carry
`Cache-Control: private, max-age=3600`. That is right for a segment, which
never changes once written and is the big file — and wrong for the playlist,
which a live game rewrites every few seconds for hours. Cached, the player
re-fetches it, is handed the copy it already had, and runs out of segments:
a live game plays for as long as it had been running when somebody opened it
and then stops, looking exactly like a recording that ends early.

So the media block splits the two:

```caddyfile
@playlist path *.m3u8
header @playlist Content-Type application/vnd.apple.mpegurl
header @playlist Cache-Control "no-store"
@segment not path *.m3u8
header @segment Cache-Control "private, max-age=3600"
```

**The Caddyfile lives on the box and not in this repository**, so nothing
enforces this. `server/routes/devMedia.ts` does the same thing for development
and does have a comment; if the two ever disagree, this is the one that decides
what a viewer sees.

## What live streaming needs on the box

**None of this has been done on the server yet** — it is written here because
the code is ready and the box is not, and because every one of these is a thing
that fails quietly rather than loudly.

1. **A port open for the ingest.** The RTMP listener binds `live.port` (1936
   while PeerTube still holds 1935). Both the droplet firewall and `ufw` have to
   allow it inbound; nothing else on the box listens there.
2. **`live.publicUrl` in `serverConfig.json`** — `rtmp://live.gamestation.co:1936`
   or whichever name the DNS gets. Without it a stream URL names the bind
   address, which is right on a laptop and useless to somebody with an encoder.
3. **`mediaSecret` set.** Without it the server generates one at boot, and every playback URL
   already in somebody's player dies the moment the server restarts — which during a game means
   every viewer's picture stops at once, a few minutes into a deploy nobody thought was risky. It
   costs one line of config and never has to change.
4. **`sessionSecret` set.** It seals the stream keys. An empty one means no
   key can be issued, which the API now says in a sentence — and changing it
   later makes every key unreadable, so they would have to be issued again
   rather than recovered.
5. **A DNS record for the ingest name**, if it is to be its own name rather than
   `gamestation.co`. Nothing in the code cares which; the URL is built from
   the setting.
6. **Disk.** A three-hour game at 3 Mbit is about **4 GB** — measured: 25 min 39 s
   at 1.5 Mbit came to 565 MiB. The segments and the finished recording sit side
   by side from the moment the remux starts until the local copy is swept six
   hours later, so the peak is **twice** that, and the copy in the Space is a
   third. `live.freeDiskFloorGb` (10 by default) refuses a new stream rather
   than filling the volume mid-game; it wants to be comfortably more than two
   games. The work volume should have room for a weekend, not one game.

The ingest runs in **one** process — the cluster primary — so nothing changes
about the systemd unit. It is off entirely when `live.enabled` is false.

## Going back

```sh
ssh root@gamestation.co /srv/gamestation/repo/src2/deploy/deploy.sh --rollback
```

Or deploy any commit by name:

```sh
ssh root@gamestation.co /srv/gamestation/repo/src2/deploy/deploy.sh 6c38532a
```

A rollback only moves the symlink; it does not undo a migration. Migrations are
written with a `down`, but running one is a decision to make with the data in
front of you, not something a deploy script should do on its own.

## Why not rsync

The previous way copied a built tree from a laptop. It went wrong twice in the
same way: `--delete` is needed so that a file removed from the source actually
goes, and it then also deletes anything on the server that the laptop does not
have — which here was a `scripts/` directory created in advance. It also made
the artefact depend on the machine that built it. Fetching a branch removes
both problems: the input is a commit, and the build happens where it runs.

## First-time setup

Done once, on 2026-09-17. Recorded here because the next box will need it.

```sh
# A key for this repo alone, read-only.
ssh-keygen -t ed25519 -f /root/.ssh/gamestation_deploy -N '' -C 'tube2 deploy'
# Add the public half to the repo as a read-only deploy key.

cat >> /root/.ssh/config <<'CONF'
Host github.com
  IdentityFile /root/.ssh/gamestation_deploy
  IdentitiesOnly yes
CONF

git clone --branch deploy \
  git@github.com:paullinator/gamestation.git /srv/gamestation/repo
```

The key is read-only and scoped to this one repository, so the box can fetch
what it runs and nothing else — it cannot push, and it cannot reach anything
else Paul owns.
