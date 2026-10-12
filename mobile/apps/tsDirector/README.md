# TS Director

An iPadOS live-directing app: receive up to five cameras, show them in a 3x3 grid alongside a
live preview of the program output, record every camera continuously to disk, scrub back through
what was recorded while recording continues, and write a program file carrying a scoreboard overlay
and a mix of whichever cameras' audio you chose.

Cameras are NearStream VM33s, received over RTSP. Sources arrive through the `FrameSource` protocol,
so nothing above it — DVR, scrub, compositor, program encode, export — knows how a frame reached the
device. See [docs/architecture.md](docs/architecture.md).

RTSP says nothing about which camera is on the other end, and the cameras are on DHCP, so the
operator names each one and the app remembers that name against the address it answered on. See
[docs/camera-identity.md](docs/camera-identity.md).

## Requirements

- Xcode 26.4 or newer, iPadOS 18.0 deployment target
- Node.js 22+ for the scripts
- [maestro-runner](https://open.devicelab.dev) for UI flows

## Setup

```bash
cd mobile/apps/tsDirector
socket npm run bootstrap     # generate Director.xcodeproj from project.yml
socket npm run fixtures      # generate test clips with burned-in frame numbers
```

## Running on the iPad

```bash
bash scripts/build-device.sh                             # build, install, launch
bash scripts/device.sh launch -sourceProfile synthetic4   # relaunch with test control enabled
node scripts/control.js --device summary                 # what the app currently thinks
node scripts/measure.js --device --seconds 20            # rates measured over a window
```

`scripts/device.sh` and `scripts/control.js` talk to a loopback HTTP control server that the app
runs only when launched with `-uiTest true`. It exists because `xcrun simctl openurl` and custom
URL schemes make iOS show a confirmation dialog, which breaks unattended automation.

Looped copies of the four captured cameras (Bonjour `_awx_service._tcp` / `_rtsp._tcp`, no NDI):

```bash
sudo -E "$(command -v node)" scripts/fakeRtspCameras.js
```

## Tests

```bash
DIRECTOR_SIMULATOR_UDID=<udid> socket npm test        # unit tests in the simulator
node scripts/run-maestro.js --list                    # available flows
node scripts/run-maestro.js --device <udid> --suite operator          # product-behavior vectors
node scripts/run-maestro.js --device <udid> smoke                     # one flow on the iPad
node scripts/run-maestro.js --device <udid> --sim rtsp-three-cameras  # camera flows in the simulator
```

The simulator inherits the Mac's network, so the camera flows can run there against the real
cameras. Thermals and sustained encode cannot: those need the iPad.

## Cameraman control

A tile whose camera is a TS Cameraman (Bonjour TXT `uuid` and `control=params/1`) shows the
phone's own thermal and battery pills and a three-dot button in its top-right corner. The button
opens the phone's operating screen full screen over the live grid — picture, thermal and battery
pills, zoom rail, flip, gear — driven over RTSP `GET_PARAMETER` / `SET_PARAMETER` on a second,
control-only connection to the phone. Zoom, flip and name are live; Settings apply on Done as one
change, exactly as on the phone. The grid, archive and programme keep flowing underneath. If the
phone stops answering the screen dims and says so rather than closing. To try it without a phone:

```bash
node scripts/fakeRtspCameras.js --cameraman "Phone 1" --only-cameraman
node scripts/run-maestro.js --sim --device <udid> cameraman-control
```

English conditions for every operator action: [docs/operator-test-vectors.md](docs/operator-test-vectors.md).

## Layout

| Path | What it holds |
|------|---------------|
| `App/` | App target: entry point, Info.plist, assets |
| `../common/DirectorCore` | Identifiers, clock, config, SQLite wrapper, paths (shared receive stack) |
| `../common/DirectorSources` | `FrameSource` protocol, camera identity, synthetic and file sources |
| `../common/DirectorRTSP` | RTSP client, RTP depacketizers, decoders, subnet search |
| `../common/DirectorRTMP` | RTMP client, send ledger, FLV tags, HEVC decoder configuration (shared with the TeamStation app) |
| `Packages/DirectorPipeline` | Pixel conversion, routing, telemetry, degradation, program encode |
| `Packages/DirectorDVR` | Segment writer, proxy store, archive index, export, retention |
| `Packages/DirectorUI` | SwiftUI views and `AppEnvironment`, which wires everything together |
| `Packages/DirectorTestHarness` | Launch arguments, control channel, control server |
| `maestro/flows` | UI flows |
| `scripts/` | Build, run, measure, and test tooling |

## Docs

- [docs/architecture.md](docs/architecture.md) — how a frame travels, and why
- [docs/camera-identity.md](docs/camera-identity.md) — how a camera keeps its name across DHCP leases
- [docs/testing.md](docs/testing.md) — how to observe and assert on a video app
- [docs/risks.md](docs/risks.md) — measured limits and what remains unproven
