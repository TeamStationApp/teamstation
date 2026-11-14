# Streaming end-to-end scenarios

The streaming suite drives a real game's live video from publishers to every kind of watcher on the bench: the TeamStation Develop app on an iPhone, an Android phone and an iPad, TeamStation TV, iPhone Safari and desktop Chrome. Every scenario runs against an attached stack (`npm run streamtest -- up` in `teamstation-devops`, then `npm run -s e2e -- stack attach <handle>`); none runs against this Mac's own stack.

| Scenario | What it shows | Video | Watchers | Minutes |
| --- | --- | --- | --- | --- |
| `streaming/basic/four-synthetic#scrub` | **Start here.** 30 minutes of live viewing and scrubbing: every angle moving, recovering within 10 s of each scrub and aligned within a second; every frame Chrome presents; memory per process | four synthetic | iPhone, Android, Chrome, TV, iPhone Safari (one angle) | 35 |
| `streaming/soak/two-hour#six-surfaces` | Two hours of scrubs, skips, slow motion, cuts, re-entries and relaunches on every surface, with gates and memory per process | two phones and one synthetic camera | iPhone (app and Safari), Android, iPad, TV, Chrome | 135 |
| `streaming/targeted/gap-seek#paused` | A paused seek into a camera's missing footage; resuming; a skip before the take | three synthetic | iPhone, Android, iPad, Chrome | 15 |
| `streaming/targeted/angle-ends#finished-game` | A camera that ends; seeking the finished game | three synthetic | iPhone, Android, iPad, Chrome | 12 |
| `streaming/targeted/publisher-outage#45s` | A camera out for 45 s, live and while rewound | three synthetic | iPhone, Android, iPad, Chrome | 14 |
| `streaming/targeted/receiver-outage#180s` | A watcher's own network out for three minutes, playing and paused | three synthetic | iPhone, Android, iPad | 25 |
| `streaming/targeted/drift#30min` | The angles' alignment, minute by minute for 30 minutes | three synthetic | iPhone, Android, iPad, Chrome | 36 |
| `streaming/targeted/cold-join#grid-opens` | A cold start opening the live grid, five times per watcher | three synthetic | iPhone, Android, iPad, Chrome | 20 |
| `streaming/targeted/owner-panel#unanswered-read` | The owner's camera panel after a read that is never answered | three synthetic | Chrome (as the owner) | 6 |
| `streaming/targeted/tv#cameras` | TeamStation TV from a cold start: sign-in, four cameras, skips, an outage, an ended camera | four synthetic | TV | 12 |

## The basic soak

`streaming/basic/four-synthetic#scrub` is the suite's baseline: four synthetic cameras publish steadily (no cuts, no network shaping) and five watchers (the develop app on an iPhone and an Android phone, Chrome, TeamStation TV, and Safari on a second iPhone watching one angle, SynthA, in the game page's own player) each get a scrub every two minutes, staggered, cycling scrub back, scrub to live, rapid scrub and Jump to present. Every 30 s each watcher is looked at. Chrome also logs every frame it presents (`requestVideoFrameCallback`), reading each frame's burned-in clock in the page (`chromeFrames.ts`), so stalls and frozen pictures are found to the frame. A look whose motion cannot be told (the TV when its NDI picture is unavailable) is blocked, not failed; a missing player or a notice on a tile still fails it. Each step's screenshot is numbered, so repeated steps keep theirs. Safari's single player names no bounds, so it is found on the screenshot by the frame's burned-in ink (`findPicture` in `clockReader.ts`). A TV that never gets past signing in fails that step and the run goes on without it; the TV needs its HDMI output (the bench's NDI encoder) to draw, and with none connected its screenshots are empty. Its report is `basic-report.md` in the run directory; the raw frames are `chrome-frames.jsonl`. `SOAK_MINUTES` shortens it for a dry run, and `BASIC_WATCHERS` (a comma list, such as `iphone,android,chrome,safari`) leaves out a watcher the bench cannot offer. Safari is only looked at, never scrubbed: its single player has no full-screen transport.

## Which claims each targeted scenario tests

The targeted scenarios test what the branches `paul/streamingReliabilityFixes` (findings S01–S10) and `paul/streamingReliabilityFixes2` (findings in its handoff) claim to fix, where simulated video can reach it.

| Scenario | Claims |
| --- | --- |
| gap-seek | S06 missing-footage notice; WEB16 paused seek into a hole; WEB06 no moment before the take |
| angle-ends | IPAD15 a finished angle is not "catching up"; S05 live to recorded; S08 seeking a finished game |
| publisher-outage | IPAD02 a tile frozen after a recording gap; S07 publisher reconnect |
| receiver-outage | S07–S09 recovery after a watcher's outage, with its pause and rewind kept |
| drift | IPADSYNC08 sub-second drift; S10 30-minute alignment |
| cold-join | ANDROID04 the cold grid never opens; IPAD03 the grid's moment taken from a reloaded tile |
| owner-panel | WEB11 the camera panel stuck after an unanswered read |
| tv | the TV's cold start; TV10 rejoin; TVSYNC09 remap; S03–S04 TV transport and recovery |

Not tested here: TV01 (needs more than four cameras; runs use at most four), IOS13 and IOS14 (need a phone's camera), SAFARI05 (develop refuses multi-angle in iPhone Safari), IPADHOLD18 (needs a real finger), S01–S02 and SERVER12 (server memory over hours; the soak samples it).

## What a run needs

- **A stack:** a streaming stack made by the operations tooling outside this repository, attached with `npm run -s e2e -- stack attach <handle file>`.
- **The app builds for that stack:** develop app builds pointed at the stack's address, installed on every watcher device; on Android, uninstall first when the signing key changed and grant `CAMERA`, `RECORD_AUDIO` and `POST_NOTIFICATIONS`.
- **Every device reserved** for the scenario's minutes plus about 15.
- **Local settings** (`~/.config/teamstation-e2e/local.json`, untracked), block `soak`:
  - `tvRemote`, `ndiCapture`, `tvJoinSteps`, `ffmpeg`, `offsetMinutes`: the bench's TV remote helper, NDI capture, TV join steps, the pinned ffmpeg and the bench clock's offset from UTC;
  - `iosApp`: the unpacked `.app` of the installed iOS build (maestro-d attaches with it);
  - `shaper` and `shapedIps`: the network conditioner's address and each watcher role's address on the shaped test network, for receiver-outage (a watcher without one is reported blocked).
- **Simulated video:** every targeted scenario publishes only synthetic cameras (`SyntheticPublisher`), each burning its label and the bench clock into its frames. No phone publishes, so the bench phones are free to be watchers.

## Running

```sh
npm run -s e2e -- run 'streaming/targeted/<behaviour>#<scenario>' --surface web-chromium \
  --stack <stack id> \
  --device iphone=<udid> --device android=<serial> --device ipad=<udid> --device tv=<udid> --device safari=<udid> \
  --run-dir ~/tmp/<run>
```

Pass the `--device` roles the scenario's watchers need (the table above); Chrome is the browser the run opens. The soak's command and its 15-minute dry run (`SOAK_MINUTES=15`) are in the soak's own header (`soak/two-hour.e2e.ts`). Runs of two hours or more go detached (`nohup`), because an agent's background command is stopped at two hours.

## Reading a run

A basic or targeted run's directory holds `basic-report.md` (basic soak only), and:

- `targeted.jsonl`: one line per step, with the surface, what was expected, what was observed (each tile moving or still, the moment its clock shows, its notice) and the verdict (`passed`, `failed`, `blocked`), and the step's screenshot;
- `targeted-summary.json`: each watcher's verdict;
- `sessions.json`: which account each live session holds (watchers are the viewer, the owner only where the scenario needs it);
- `recoveries.jsonl`: each time a device's driver was lost and attached again;
- `mirror/`: the stack's API log over the run.

The scenario passes when no watcher failed a step, and is blocked when every watcher was blocked. The tiles' moments come from the burned-in clocks (`e2e/rigs/streaming/clockReader.ts`), so a picture that is covered or frozen shows as a missing or stale moment, not as a guess.

## Where the code is

- `e2e/rigs/streaming/streamingSession.ts`: the world, sign-in, device attach and the TV, shared by the soak and the targeted scenarios.
- `e2e/rigs/streaming/basicSoak.ts`: the basic soak; `chromeFrames.ts`: Chrome's every-frame log and its analysis.
- `e2e/rigs/streaming/targeted.ts`: the runner both the basic soak and the targeted scenarios use; `targetedScenarios.ts`: the eight scenarios' steps; `targetedSpec.ts`: how each becomes a suite scenario.
- `e2e/rigs/streaming/soakWiring.ts`, `soakRun.ts`, `soakSchedule.ts`, `soakGates.ts`, `soakMemory.ts`, `soakReport.ts`: the soak.
- `e2e/rigs/streaming/surfaces/`: the watcher drivers (maestro-d for the apps, Safari and Chrome; the remote helper for the TV).
- `e2e/rigs/streaming/syntheticPublisher.ts`, `syntheticFrames.ts`, `clockReader.ts`: the simulated camera and reading it back.
