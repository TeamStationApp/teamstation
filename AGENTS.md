# Agent guidelines for teamstation

## Push your work

**Do not leave code on the local machine, committed or uncommitted.** Local commits are not
backed up remotely. Push changes so maintainers can review them from any workstation.

- Commit and `git push` as soon as a change is coherent. Do not wait to be asked.
- Feature branches only. Never push directly to `master`.
- **Never force-push `master` or `develop`.** Force-pushing your own feature branch, to fold
  fixups or rebase it, needs no say-so: use `--force-with-lease`, after pushing a backup
  branch of what it replaces.
- Anything else genuinely destructive — deleting someone else's branch, rewriting history
  someone else's work builds on, discarding someone else's commits — requires explicit user approval.

If a change is not ready to push, it is not finished; say so rather than leaving it on disk.

## This repository is public: privacy and security

Everything committed here — code, tests, fixtures, docs, comments and commit messages, in every
commit of every branch — is published. A branch is not ready for a PR or a merge until you have
reviewed it for what follows and fixed what you found.

### Never commit

- **Real people's names**: players (most of them children), parents, guardians, coaches,
  scorekeepers, users. Nor anything that identifies them indirectly: their teams, clubs, leagues,
  fields, schools or neighbourhoods, real game dates and scores, screenshots or photos of rosters.
  Keep author attribution in `package.json`; use neutral roles in documentation.
- **Credentials of any kind**: API keys, tokens, passwords, private keys, session or signing
  secrets, invite codes, stream keys, including "test" values copied from a real system.
- **How the servers are laid out or run**: hostnames other than the public product domains,
  addresses of real networks (the test bench included), which port or database serves what in
  production, bucket, cluster, cache and volume names, server paths, process-manager and
  reverse-proxy setup, deploy and provisioning steps, firewall rules, SSH access, which accounts can
  do what, and counts or contents of production data. Deployment scripts and runbooks are kept in a
  separate private repository: never add them here.
- **Personal device identifiers**: UDIDs, serial numbers, MAC addresses, device names
  (`<name>'s iPhone`), Wi-Fi network names, local hostnames, home-directory paths.
- `Co-authored-by:` trailers.

### What to use instead

| Instead of | Use |
| --- | --- |
| A person's name | A real MLB player's name. A team named for its coach takes an MLB player's surname. |
| A real team, league, club, field or place | A neutral invented one. |
| A real network address | `192.168.x.x` where the code needs a private address, otherwise a documentation range (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`). Never an address from a real network. |
| A hostname | `*.example.test` (or `example.com`). |
| A server or home path | `/var/app/...`, `/Users/dev/...`. |
| A device identifier | A zero-filled value of the same format (`00000000-0000-4000-8000-000000000001`, `02:00:00:00:00:01`), keeping any prefix the code requires. |
| A secret, code or key | A placeholder of the same shape. |
| Prose about the infrastructure | The engineering reason without the layout: "behind the reverse proxy, the client address comes from X-Forwarded-For", not where the proxy runs or what it forwards to. |

### Before every PR or merge

1. **Read every commit on the branch yourself**, in order, with its message:
   `git log --reverse --format='%n==== %h %an%n%B' -p origin/master..HEAD`. Read every added file in
   full, not only the hunks, and open every added image, video, audio file and PDF.
2. Ask of each line whether it could identify a real person, or help someone map or reach the
   servers. When you cannot tell whether a name is real, replace it.
3. **Fix each finding by hand**, one occurrence at a time, in the file with the context in front of
   you. No search-and-replace tools, regex replacement or scripts: use `grep` only to find what is
   left. Keep the shape the code and tests rely on (length, initials, a required prefix, an escaped
   apostrophe) and keep it consistent across every file that refers to the same thing.
4. **Fix it in the commit that introduced it**, not in a commit on top: the history is published
   too. Fold the fixes in with fixup commits and a rebase of your own branch.
5. Change data only (fixtures, test strings, comments, docs, commit messages), never behaviour, and
   run the tests the changed files belong to.
6. Optionally, check for credentials with gitleaks:
   `gitleaks git --log-opts="origin/master..HEAD"`. It is a second opinion, not the review.
7. When you hand the branch back or open the PR, say that you did this review and what you changed,
   by kind, without quoting what you removed. Tell the user at once about anything that may already have
   leaked: a credential has to be rotated and an invite code revoked, whatever the history says.

## UI rules

Before adding or changing a screen, read [docs/ui-rules.md](docs/ui-rules.md). A picker of more
choices than fit on one line is a list of rows, never pills, and stacked Cancel actions are centered, using blue beneath a red destructive primary and red otherwise.
Pill labels stay on their straight run, with horizontal padding of at least half
the explicit shell height; see the pill rule in that document.

## API design

Before adding or changing a route under `/api/v1`, read [docs/api.md](docs/api.md). A filter
or a search is a query parameter on the collection that already exists, never a new path.

## Dictation phrases

When a sentence scores wrong and you add it to the dictation prompt, add that sentence to the
Haiku integration tests and rerun all of them. See [docs/dictation.md](docs/dictation.md).

## TS Director: pass the device UDID

Whenever asked to **fix, change, or finish** TS Director (`mobile/apps/tsDirector`), treat
verification as part of the work — not an optional follow-up.

### Device

- Do **not** hard-code a simulator or hardware UDID in scripts, tests, docs defaults, or agent
  rules.
- The user specifies the target for the run. Pass it as `DIRECTOR_DEVICE_UDID` (or
  `DIRECTOR_SIMULATOR_UDID` for a simulator). Fail if it is missing.
- A test must not name a device; it reads the UDID from the environment and passes it to
  maestro-d as `device:`, so the same test can hit different iPads.
- Do not boot or shut down simulators. Target an already-running instance.
- Do not use the 2018 A12X unless the user explicitly selected it.

### How much testing

After the code change, run **as much of the testing that already exists** as the change can affect:

1. Once per checkout, a `clientConfig.json` in `mobile/apps/tsDirector/` (gitignored: the signing
   team and the app link host, from the deployment repository's `appLinks.mjs client director`);
   every Director build and test script stops without it
2. `DIRECTOR_DEVICE_UDID=<udid> ./scripts/build-sim.sh` (simulator) or `build-device.sh`
   (hardware) so there is an `.app` to test
3. `DIRECTOR_SIMULATOR_UDID=<udid> ./scripts/test-unit.sh` when Swift logic changed
4. The maestro-d TypeScript tests that cover the product/UI/pipeline area you changed (see
   **UI and device tests** below)

Quote the line that names the UDID. Fix failures before handing back.

### Before launching a build on an iPad holding footage

Retention sweeps the camera archive at app launch. Check the build's retention settings before
running anything against an iPad with an unrecovered take on it. A short retention window can
delete an unrecovered take, so check the setting before that build.

## UI and device tests: maestro-d in TypeScript

Every UI, simulator, emulator and device test is driven by **maestro-d** and written in
**TypeScript** against its JavaScript client (`import { MaestroD } from 'maestro-d'`, or the
client under `MAESTRO_D_CLIENT_ROOT` as `scripts/scoring-feedback-safari.mjs` loads it). This
applies to every app in the repository: TS Director, TS Cameraman, TS Watcher, TS Distributor and
the web app in a mobile browser.

- **No new Maestro YAML flows.** Do not add `.yaml` flows, and do not use `maestro-runner test` or
  `scripts/run-maestro.js` as the test for new work. The YAML flows that already exist stay until
  someone migrates them; they are not the standard, and they are not required for handing back.
- Write a test as a `.ts` file beside the app it drives (for example
  `mobile/apps/tsDirector/e2e/<name>.e2e.ts`), run with `node -r sucrase/register <file>`.
- Each agent uses its own daemon name (`MAESTRO_D=<name>`); daemons are not shared. Run
  `maestro-d ps` before attaching, and always pin the device with `device:`.
- The maestro-d docs are in `~/git/maestro-d/docs/daemon/` (`js.md`, `rest.md`, `cli.md`,
  `commands.md`).
- A result on a real device is confirmed with a frame from the bench webcam as well as a maestro-d
  screenshot.
