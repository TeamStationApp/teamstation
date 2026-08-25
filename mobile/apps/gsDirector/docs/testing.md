# Testing

Video is opaque to normal UI automation. A tile that renders a frozen frame and a tile that
renders live look identical to an accessibility tree, so the app publishes what it is actually
doing and the tests assert on that.

## Three ways to observe the app

**The debug HUD** overlays counters on the grid. Useful when watching by hand; not what the
tests read.

**Accessibility values.** Every tile exposes a compact string:

```
state=live src=VM33_00D9D f=246 off=0.0 onair=1
```

Maestro asserts on substrings of this, which is why the shape is a contract rather than a
convenience.

A tile's value carries the archive height as `arch=`, which is how a flow tells the difference
between a tier being *reported* and a tier being *applied*:

```
tile=1 state=live src=VM33_00D9D f=246 off=0.0 onair=1 arch=720 out=30
```

`f=` counts arrivals even while the tile is paused on a still. `out=` is the rate of frames that
actually reached the display layer — that is how Return to Live is proven not frozen.

**The control server.** When launched with `-uiTest true`, the app runs a loopback HTTP server
on port 8765. It exists because custom URL schemes make iOS show a confirmation dialog that
breaks unattended runs.

```bash
node scripts/control.js --device summary          # one-line state
node scripts/control.js --device state            # full JSON dump
node scripts/control.js --device enable 1 2 3     # enable sources (1-based)
node scripts/control.js --device send /start
node scripts/control.js --device send "/record?on=true"
node scripts/control.js --device send "/name-camera?index=1&name=Third%20Base"
node scripts/control.js --device send "/bind-camera?index=1&name=First%20Base"
node scripts/control.js --device send /search-cameras
node scripts/control.js --device send "/source-layout?order=5,1,2,3,4"
```

The camera commands exist so identity can be asserted without driving a menu by coordinates, and
`/search-cameras` forces a search while production has the periodic one switched off.

### Launch camera runs through Maestro, not `devicectl`

An app launched by `xcrun devicectl device process launch` discovers **zero** cameras; the same
build launched by Maestro finds all three at once. Whatever grants local-network access does not
apply to that launch path, and nothing in the app reports an error — discovery is simply empty.

So anything involving real cameras starts by letting a flow launch the app, then drives the running
process over the control server:

```bash
node scripts/run-maestro.js --device <udid> smoke   # launches, selects cameras, enters the grid
node scripts/control.js --device send "/record?on=true"
node scripts/measure.js --device --seconds 30
```

Synthetic and file profiles are unaffected and can be launched with `scripts/device.sh launch`.

### The camera flows also run in the simulator

The simulator inherits the Mac's interfaces, so a simulator run reaches the same cameras the iPad
does — as long as the Mac is on their network, wired or not:

```bash
DIRECTOR_SIMULATOR_UDID=<udid> bash scripts/build-sim.sh
node scripts/run-maestro.js --device <udid> --sim rtsp-three-cameras
node scripts/run-maestro.js --device <udid> --sim rtsp-camera-naming
node scripts/run-maestro.js --device <udid> --sim rtsp-camera-rebind
```

That covers the transport, the search and the identity rules against real cameras without the iPad on
the bench. It says nothing about thermals, sustained encode or either iPad's decode capacity, all of
which are the reasons the device runs still exist.

Two caveats, both learned the hard way. The app is letterboxed on a portrait iPad simulator, so the
percentage coordinates in the scrub flows do not land where they do on the device — run the scrub
flows on the iPad. And the simulator finds cameras through whichever interface the Mac is using,
including Ethernet, which is why `SubnetScanner` looks at every non-loopback interface rather than
`en0`.

### Which iPad

Every script takes the target UDID before it runs (`--device <udid>`, `DIRECTOR_DEVICE_UDID`, or
`DIRECTOR_SIMULATOR_UDID`). Flows in `maestro/flows` do not name a device, so parallel agents can
point the same YAML at different machines. Two very different iPads have been used here — a 2018
A12X and an M4 — and `run-maestro.js` prints the model it was given:

```bash
export DIRECTOR_DEVICE_UDID=<udid>            # physical scripts
export DIRECTOR_SIMULATOR_UDID=<udid>         # build-sim / test-unit
node scripts/run-maestro.js --device <udid> --suite operator
```

`run-maestro.js` prints the UDID it was given. Quote that line with any measurement. A number in
`docs/risks.md` without a device attached to it cannot be compared with anything.

### What to look at when a camera does not appear

`discoveryStatus`, in the HUD and the state dump, reports the search rather than its conclusion:

```
scan=10.10.7.0/24 probed=253 open=3 confirmed=3 streaming=0 manual=0
```

`open` counts hosts with port 554 listening; `confirmed` counts those that then described a video
track this app can decode. `open` above `confirmed` means something else is on that port.
`probed=0` with a subnet named means the mask was too wide to scan; `scan=off` means scanning is
switched off and only `rtspHosts` will be tried.

Per camera, `loss=` in the HUD counts RTP packets that never arrived, and `src=` carries the reason a
source last stopped delivering — `no frames for 5s` is a session that went quiet without an error,
which is the failure a flapping link actually produces.

## Measuring rather than sampling

`framesPerSecond` in a single dump is instantaneous and jitters hard with network sources — one
reading told us 0.2 fps and the next 4.5 fps for the same stream. Anything that claims a source
is or is not keeping up must measure over a window:

```bash
node scripts/measure.js --device --seconds 20
```

It reports arrival, encode and proxy rates per tile alongside what the source *says* it is
sending, which is what separates a network problem from a pipeline one.

### Counters are not files

Telemetry proves buffers reached a writer. Whether the bytes on disk are playable at the expected
rate is a separate question, and every archive bug found so far produced healthy counters beside
unusable output. So after a recording, decode what actually landed:

```bash
node scripts/verifyProgram.js     # programme master: rate, audio track, scorebug burn-in
node scripts/verifyArchives.js    # newest recording, each camera's first segments
```

Both pull from the device and run `ffprobe`. `verifyProgram.js` also writes a still to
`artifacts/program/frame.png`, which is the only way to see the composited picture at all — the
programme tile is an `AVSampleBufferDisplayLayer`, and WebDriverAgent screenshots exclude hardware
video layers. `verifyArchives.js` reconstructs a playable file by concatenating the initialization
segment with the first media segments, so it takes the init segment's name from the device listing
rather than assuming one; a missing `moov` is reported by `ffprobe` as invalid data, which reads as
a corrupt archive when the file was never assembled properly in the first place.

### Is the network the limit, or are we?

A source delivering 4 fps looks identical whether the link cannot carry it or the app cannot keep
up. The control server serves ballast so the link can be measured directly:

```bash
curl -s -o /dev/null -w '%{speed_download} B/s\n' \
  "http://<ipad-wifi-ip>:8765/throughput?bytes=33554432"
```

Compare against the same request over USB — a large gap is the link, a small one is us. This is how
a full-resolution collapse was pinned to a 15 Mbps Wi-Fi link rather than the pipeline.

Check the *host's* route before comparing against a desktop receiver: `route -n get default`.
A Mac on Ethernet is not a test of the same network.

### When a recording will not stop, compare the two clocks

Tile telemetry publishes `archiveVideoSeconds` and `archiveAudioSeconds`. They must stay close
together. If they do not, the muxer is being asked to span a timeline that does not exist and
`finishWriting` will never return — the symptom is a stop that sits at stage `finishing archives`
until the deadline fires and reports a possibly-truncated file:

```bash
node scripts/control.js --device state | \
  node -e '…; for (const t of s.tiles) console.log(t.archiveVideoSeconds, t.archiveAudioSeconds)'
```

`dvr.lastFlushSeconds` records how long the last stop spent flushing. Healthy is under a second.

## Probing the encoder when recording fails

`AVAssetWriter` reports every encode problem as `Cannot Encode`, whether the cause is a bad setting,
a busy device, or a wedged encoder. Two probes separate those cases, both reachable over the control
server and both reporting into `encodeProbe` in the state dump.

```bash
# How much 1080p encoding can this device sustain, in 30 fps stream equivalents?
curl "http://<ipad>:8765/probe-throughput?sessions=4&seconds=20&height=1080"

# Does the hardware encoder actually emit compressed frames? Count emitted, not accepted.
node scripts/control.js --device send "/probe-encoders?max=1&frames=30"

# How many concurrent 1080p sessions will this device give us?
node scripts/control.js --device send "/probe-encoders?max=8"

# Will an AVAssetWriter configured the way the DVR configures it accept a stream of frames?
node scripts/bisect-writer.js 30
```

`bisect-writer.js` sweeps segmented versus plain-file writers, minimal versus full compression
settings, our buffer pool versus the adaptor's, and both codecs. If every configuration fails the
problem is the device, not the settings — see `risks.md` for the run where that happened.

Read the probe output carefully: `frames accepted` only means VideoToolbox queued them. `emitted` is
the number it actually compressed, and that is the number that says the encoder works.

## Chasing a stutter

Frame rate will not show you a stutter. A tile missing one frame a second still reports 30 fps and a
two-millisecond mean, so the numbers to read are extremes from a single second:

```bash
node scripts/jitter.js --device --seconds 20            # while live
node scripts/jitter.js --device --seconds 20 --record   # with the DVR running too
```

`gap` is the widest space between two arriving frames in one second, and a trailing `k` means that
gap ended on a keyframe — the camera's own pacing. `deliver` is the longest a single frame spent being
decoded and delivered on the receive thread, which is time we did not spend reading the socket. The
same two figures per tile are in the HUD as `gap=` and `dlv=`.

`buffer needed` answers a different question: how much video a smoothed preview would have to hold to
present every frame on time, taken as the spread between the least and most late arrival against the
frames' own timestamps over ten seconds. It needs a longer run than the other two — give it at least
60 seconds so several windows close — and appears in the HUD as `buf=`.

Since frames are held in a delay line and released against their own timestamps, the number that says
whether the operator sees a stutter is `release` (`rel=` in the HUD), which is the same widest gap
measured on the way out. Read it against `gap`:

| `gap` | `release` | `late` | Reading |
|---|---|---|---|
| 200–500 ms | one frame interval | 0 | Normal. The camera bursts, the buffer absorbs it. |
| 200–500 ms | tracks `gap` | climbing | The buffer is too small, or has just started and has not sized itself yet. |
| one frame interval | one frame interval | 0 | The camera is not bursting at all — check it is really streaming. |
| any | spikes with `dlv` | 0 | Our own work on the release tick, not the camera. |

`held` (`pl=`) is the delay being paid for that, and `late` counts frames that arrived after they were
due. A handful of `late` frames in the first seconds of a camera is the controller finding its size;
`late` climbing during steady streaming is a real problem.

Read them together. A `gap` of several frame intervals with a small `deliver` is the camera or the
link; a `gap` that tracks `deliver` is our own work on that thread. To rule the app out entirely,
measure the stream itself from the Mac — sizes are reliable even when arrival timing through a pipe is
not:

```bash
ffprobe -rtsp_transport tcp -i rtsp://<camera>:554/live/mainstream \
  -select_streams v -show_entries packet=pts_time,size,flags -of csv=p=0
```

A keyframe that is half of its second of video takes half a second to arrive, and no app-side change
makes it arrive sooner — see the keyframe entry in `risks.md`.

## Launch arguments

| Argument | Effect |
|----------|--------|
| `-uiTest true` | Enables the control server and the control channel |
| `-sourceProfile synthetic4\|file4\|rtsp` | Which sources to use |
| `-clearState true` | Forget saved source selection, source-tile order, last Output camera, and every named camera |
| `-failEncoders N` | Fault injection for the degradation ladder |
| `-segmentSeconds N` | Shorter segments so a flow produces several in seconds |
| `-rtspHosts a,b,c` | Cameras to try directly, bypassing the search |
| `-rtspScan false` | Turn the subnet search off, leaving only `rtspHosts` |
| `-rtspPath /live/mainstream` | Stream path to request |
| `-rtspTransport tcp` | Only TCP is implemented; `udp` fails rather than quietly using TCP |

With no `-sourceProfile`, the Settings switch decides: simulated cameras on gives `synthetic4`, off
gives `rtsp`. An app opened from the home screen passes no arguments, so it searches for real
cameras — which is the only profile a device can actually fill, since the `file4` fixtures ship with
the test runner rather than the app.

## Maestro flows

```bash
node scripts/run-maestro.js --list
node scripts/run-maestro.js --device <udid> --suite operator
node scripts/run-maestro.js --device <udid> smoke
```

Operator-facing conditions (tap to program, scrub a preview, cut a rewind, Return to Live not
frozen, mix, cap, empty slots) live in [operator-test-vectors.md](operator-test-vectors.md).

Flows involving real cameras run on the iPad, or on a simulator with `--sim` when the Mac is on the
camera network. Two device-specific requirements the runner handles: `--team-id` for WebDriverAgent
signing, and `--app-file` for any flow using `clearState`, since the runner reinstalls the bundle to
clear it.

| Flow | Gate |
|---|---|
| `smoke` | Toolchain and UI automation work at all |
| `rtsp-three-cameras` | All three real cameras found by search, decoded, live, nothing lost |
| `rtsp-camera-naming` | A named camera is recognised again by address at the next launch |
| `rtsp-camera-rebind` | A wrong auto-match can be corrected from the cache in one tap |
| `operator-*` | Product vectors in [operator-test-vectors.md](operator-test-vectors.md) |
| `record-and-stop` | Recording starts, segments accumulate, the stop *completes*, program file exists |
| `scrub-and-return` | Scrub back through history while recording continues, then return to live |
| `scrub-incremental` | A second swipe continues from the playhead, not from live |
| `recordings-export` | Recordings lists a stopped take, Export is offered, Select All + Delete removes it |

Screenshots and hierarchy dumps land in `maestro/reports/<timestamp>/assets/`.

**This runner ignores `text` when an `id` is also present in a selector.** `{id: hud-recording,
text: 'rec=0'}` therefore passes the instant the label exists, whatever it says — which made a
number of assertions here vacuous until it was caught with `maestro/flows/matcher-check.yaml`.
Any assertion about a *value* must use a text-only selector.

## Fixtures

`scripts/make-fixtures.js` generates H.264 and HEVC clips with the frame number burned into the
image, plus a JSON sidecar listing the expected markers. Decoding a fixture and reading the
markers back is how encode fidelity is checked without comparing pixels.

## Inspecting what was written

```bash
xcrun devicectl device info files --device <udid> \
  --domain-type appDataContainer --domain-identifier co.gamestation.director
```

Archives live under `Library/Application Support/GSDirector/Archives/<source>/rec-<n>/`, as an
`init.mp4` plus numbered segments. Segments are fMP4 and are not playable alone — `SegmentAssembler`
concatenates them with the initialization segment for replay and export.
