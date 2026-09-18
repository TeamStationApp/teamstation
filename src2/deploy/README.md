# Deploying GameStation 2.0

The server fetches a branch and builds it. Nothing is copied from a laptop, so
a deploy depends on a commit and not on the state of whoever ran it.

```sh
ssh root@tube.gamestation.co /srv/gamestation/repo/src2/deploy/deploy.sh
```

## The deploy branch

**`deploy` is what the server follows, and it is whatever is on the server.**
Moving it is the act of deploying:

```sh
git push --force-with-lease origin <your-branch>:deploy
ssh root@tube.gamestation.co /srv/gamestation/repo/src2/deploy/deploy.sh
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
ssh root@tube.gamestation.co git -C /srv/gamestation/repo log --oneline -1
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

## Going back

```sh
ssh root@tube.gamestation.co /srv/gamestation/repo/src2/deploy/deploy.sh --rollback
```

Or deploy any commit by name:

```sh
ssh root@tube.gamestation.co /srv/gamestation/repo/src2/deploy/deploy.sh 6c38532a
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
