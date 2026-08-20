# GS Producer: RTSP rewrite plan

Status: **draft for review — do not execute yet.**

Execution of this plan MUST follow the `agent-operation-logs` skill
(`~/.cursor/skills/agent-operation-logs/SKILL.md`) and the always-apply rule of the same
name. See [Operation timing log](#operation-timing-log).

---

## 1. Why

NDI is being abandoned as the camera transport. Three NearStream VM33 cameras now have NDI
disabled and broadcast RTSP instead:

```
rtsp://{camera-ip}:554/live/mainstream
```

Two consequences drive the whole design:

1. **There is no unique camera identifier.** RTSP carries no stable device identity. The URL
   path is identical on every VM33, the SDP `o=` origin is a *session* id, RTP SSRC is random
   per stream, and the VM33 exposes no ONVIF or UPnP serial. The only thing distinguishing one
   camera from another on the wire is its IP address — and the DHCP server is a Starlink
   router, which cannot pin leases. So IP is a *hint*, not an identity.
2. **RTSP delivers a compressed bitstream.** Unlike the NDI SDK (which decodes internally and
   hands back uncompressed pixels), RTSP gives us H.264/HEVC NAL units directly. This removes
   the central constraint that `docs/architecture.md` is written around. It is a large
   opportunity, deliberately deferred to Phase 6 so that Phases 1–5 remain a like-for-like
   swap that keeps every existing test meaningful.

Identity is therefore solved in the app, not on the wire: the operator names each camera, and
the app remembers the name alongside the last IP that answered to it.

---

## 2. Decision required before execution

**Which RTSP client implementation?** This is the single largest risk in the plan and the
reviewer should settle it before an agent starts.

| Option | Pros | Cons |
|---|---|---|
| **A. Hand-rolled RTSP + RTP + VideoToolbox** (recommended) | No third-party dependency or licence question; full access to the compressed bitstream, which Phase 6 needs; parsers are pure functions and therefore genuinely unit-testable; matches the existing vendored-C comfort level | Most code to write; must handle FU-A/STAP-A reassembly, digest auth, keepalives, reconnect |
| **B. FFmpeg (libavformat) via an xcframework** | Battle-tested demuxer; handles odd cameras | LGPL dynamic-linking obligations; large binary; `ffmpeg-kit` is no longer maintained, so the build would need to be produced and vendored in-house |
| **C. MobileVLCKit** | Fastest to a moving picture | Awkward to get per-frame `CVPixelBuffer` with timing; no clean compressed-bitstream access, so Phase 6 becomes impossible; heavyweight |

**Recommendation: Option A.** The camera population is narrow and known: three VM33s, one video
track plus one AAC audio track each, TCP-interleaved transport, no authentication. The
`FrameSource` protocol is the seam — if the hand-rolled client stalls, B or C can be dropped in
behind the same protocol without touching anything downstream.

**Amended after Phase 0 (see 11.0):** the cameras are *not* identical — two speak H.265 and one
speaks H.264 — so Option A costs two depacketizers rather than one. That is a real increase over
the original estimate, and it is the strongest argument the plan has for Option B. Option A is
still recommended, because the codec split cuts both ways: the second depacketizer is perhaps
300 lines of pure, fully testable parsing, whereas Option B brings an LGPL obligation and an
in-house FFmpeg build for the same result, and forecloses nothing less than Phase 6.

The rest of this plan assumes Option A.

---

## 3. Prerequisites (physical, before any device run)

- All three VM33s have NDI **disabled** and are on the same subnet as the iPad.
- In the NearStream app, set **Camera Input Quality** on each camera. With NDI off it can
  default back to 720p; the RTSP stream inherits the app-mode input quality, so set it to
  1080p HIGH if the run is meant to characterise 1080p.
- Record each camera's serial (`VM33_XXXXXX`, on the silver sticker) and current IP. The plan
  needs this to sanity-check auto-binding.
- Confirm each camera answers:

```bash
printf 'OPTIONS rtsp://CAM_IP:554/live/mainstream RTSP/1.0\r\nCSeq: 1\r\n\r\n' | nc CAM_IP 554
```

---

## 4. Branch strategy

The aim is a branch whose history never contained NDI. Not "NDI removed in a commit" — never
present at all. So the producer work is parked on a WIP branch, `master` is rolled back to
`origin/master`, and the app is rebuilt on a fresh branch cut from `origin/master`, porting the
non-NDI code across from the WIP branch.

### 4.0 Verified starting state

- `origin/master` is **`a1e4697`** and contains no `mobile/apps/gsProducer` directory at all.
- Local `master` is **4 commits ahead and 0 behind**, and all four are the producer work:
  `3950010`, `31bec7f`, `c2782f8`, `fa96ac4`.
- The working tree adds substantial **uncommitted** work on top: `AudioMixer.swift`,
  `ScrubMapping.swift`, `ReplayHTTPServer.swift`, `ProgramTileView.swift`, three new test files,
  a dozen new Maestro flows, `verifyProgram.js`, `scorebugServer.js`, and doc updates. Most of
  it is not NDI-specific and must survive.

### 4.1 Park the current work

```bash
cd /Users/paul/git/gamestation
git switch -c paul/ndiWip
git add -A ':!mobile/apps/gsProducer/artifacts' ':!.cursor'
git commit -m "WIP: NDI-based GS Producer pipeline"
```

This happens first. After it, `paul/ndiWip` is the only copy of the four producer commits plus
every uncommitted change.

Excluded deliberately:

- `mobile/apps/gsProducer/artifacts/` — an mp4 and captured frames; build output, not source.
- `.cursor/` — local agent config.
- `DerivedData/`, `Vendor/NDI/`, `reports/`, `fixtures/*` — already covered by
  `mobile/apps/gsProducer/.gitignore`.

### 4.2 Roll master back to origin/master

```bash
git switch master
git reset --hard origin/master   # a1e4697
```

`git reset --hard` is destructive. It is only safe because 4.1 already preserved everything.
**Run these three checks first and do not proceed unless all three pass:**

```bash
git log --oneline -1 paul/ndiWip     # shows the WIP commit
git branch --contains 3950010        # lists paul/ndiWip
git status --porcelain               # empty apart from ignored paths
```

`master` is 0 behind `origin/master`, so this is a pure rewind. **No force push**, and no push
of `master` at all — the remote already matches where local master is being moved to.

### 4.3 Cut the new branch from origin/master

```bash
git switch -c paul/gsProducer origin/master
```

Branch names follow the `<firstname>/<camelCaseName>` rule. The branch starts with no
`gsProducer` directory whatsoever; every file arrives by deliberate port.

### 4.4 Port the app across, minus NDI

Bring the whole app over in one operation, then drop the paths that must never exist here:

```bash
git checkout paul/ndiWip -- mobile/apps/gsProducer

git rm -r -q --ignore-unmatch \
  mobile/apps/gsProducer/Packages/ProducerNDI \
  mobile/apps/gsProducer/tools/ndiRate.c \
  mobile/apps/gsProducer/scripts/setup-ndi.sh \
  mobile/apps/gsProducer/Tests/ProducerUnitTests/NDIDiscoveryTests.swift \
  mobile/apps/gsProducer/maestro/flows/ndi-three-cameras.yaml \
  mobile/apps/gsProducer/maestro/flows/ndi-four-cameras.yaml \
  mobile/apps/gsProducer/maestro/flows/ndi-four-cameras-audio.yaml \
  mobile/apps/gsProducer/maestro/flows/ndi-full-bandwidth.yaml \
  mobile/apps/gsProducer/maestro/flows/ndi-no-archive-audio.yaml \
  mobile/apps/gsProducer/maestro/flows/ndi-hevc-scrub.yaml
```

The `ndi-*.yaml` flows are dropped here and reappear as `rtsp-*.yaml` in Phase 5 (section 10.4)
rather than being renamed in place, so no NDI filename ever enters this branch's history.

`Vendor/NDI/` needs no `git rm`: it is **untracked**, ignored by
`mobile/apps/gsProducer/.gitignore` line 24, and fetched at setup time by `setup-ndi.sh`. Delete
the local directory (`rm -rf mobile/apps/gsProducer/Vendor`) and remove the ignore rule.

Then edit, before the first commit:

| File | Edit |
|---|---|
| `.gitignore` | drop the `Vendor/NDI/` rule and its comment; add `artifacts/` |
| `package.json` | remove the `"setup:ndi"` script |
| `scripts/bootstrap.sh` | remove the `libndi_ios.a` fetch check |
| `scripts/build-device.sh` | remove the `Vendor/NDI/lib/libndi_ios.a` guard and the "device builds are the only way to exercise NDI" rationale |
| `project.yml` | see 9.2 |
| `App/ProducerApp.swift` | see 9.3 |
| `App/Info.plist` | see 9.4 |
| `Packages/ProducerSources/.../SourceDiscovery.swift` | drop the `.ndi` case of `SourceKind` and `SourceProfile`; `.rtsp` is added later, in commit 3 (see 9.1) |
| `Packages/ProducerUI/.../AppEnvironment.swift` | `ndiDiscoveryFactory` → `discoveryFactory`; `ndiUnavailableReason` → `discoveryUnavailableReason` |
| `Packages/ProducerUI/.../SourceSelectionView.swift` | drop `NDIAttribution`; rename the `ndi-unavailable` identifier; rewrite the empty-state copy |
| `Packages/ProducerPipeline/.../PipelineTelemetry.swift` | see 9.5 |
| `Packages/ProducerTestHarness/.../LaunchConfiguration.swift` | see 9.6 |
| `Tests/ProducerUnitTests/SourceSelectionTests.swift` | the retain-by-kind fixture becomes `.synthetic`, then `.rtsp` in commit 3; the assertions are unchanged either way |
| `scripts/run-maestro.js`, `ablation.js`, `compareReceivers.js`, `control.js` | drop `ndiBandwidth` / `ndiExtraIps` plumbing and NDI wording |
| `maestro/flows/shared/allow-local-network.yaml` | reword the NDI comment |
| `maestro/flows/live.yaml`, `record-and-stop.yaml`, `program-scorebug.yaml` | `sourceProfile: ndi` → `synthetic4`, repointed to `rtsp` in commit 3 |
| `docs/architecture.md`, `docs/testing.md`, `docs/operator-test-vectors.md`, `README.md` | rewrite the NDI narrative |
| `docs/risks.md` | **port verbatim** — see below |

`docs/risks.md` is the deliberate exception. It is a lab notebook of measurements actually taken,
and the transport those runs used is a fact about them. Renaming it to "the previous transport"
would make the numbers harder to interpret and would blur exactly the kind of series boundary the
Peltier rule exists to protect. It is carried across unchanged, and it is the one file the sweep
below is allowed to skip.

Sweep for stragglers before committing:

```bash
rg -i -n 'NDI|\bndi' mobile/apps/gsProducer \
  --glob '!docs/rtsp-rewrite-plan.md' --glob '!docs/risks.md' \
  --glob '!DerivedData/**' --glob '!maestro/snippets/**' --glob '!maestro/reports/**' \
  --glob '!reports/**' --glob '!Producer.xcodeproj/**' --glob '!fixtures/**'
```

Two details make the difference between this sweep working and wasting an hour. Matching
`NDI|\bndi` rather than a bare `ndi` substring is what excludes "ca**ndi**dates" in
`scripts/device.sh` and "depe**ndi**ng" in prose, while still catching camelCase identifiers like
`ndiBandwidth` that a `-w` word-boundary search would miss on both ends. And the build-output
globs matter because `DerivedData/`, `maestro/snippets/` and `Producer.xcodeproj/` are ignored by
git but not by ripgrep, and `maestro/snippets/` alone is several gigabytes.

The sweep should end up empty.

### 4.5 Commit shape

Three commits on `paul/gsProducer`, none of which mentions NDI, porting, or the WIP branch:

1. **`Add GS Producer, an iPadOS live production app`** — the ported scaffold with synthetic and
   file sources only. This is a genuinely working app: `synthetic4` and `file4` need no network
   transport, so it builds, runs and passes the retained tests before any RTSP code exists.
2. **`Add camera identity and naming`** — Phase 2.
3. **`Add the RTSP camera transport`** — Phases 3–5, split further as convenient.

Per the commit-message rule, describe the final state only. No "removed NDI", no "ported from
the WIP branch", no contrast with the previous transport.

---

## 5. Camera identity model

This is the heart of the change. Read this section carefully before writing code.

### 5.1 Three distinct concepts

Today `SourceID` conflates "what the network advertises" with "which camera this is". That
worked because NDI names embedded the serial. It cannot work now. Split into three types:

```swift
/// What discovery finds on the network this instant. Entirely transient.
public struct CameraEndpoint: Hashable, Sendable, Codable {
  public let host: String   // "192.168.1.37"
  public let port: Int      // 554
  public let path: String   // "/live/mainstream"
  public var url: String { "rtsp://\(host):\(port)\(path)" }
}

/// What the operator named, and what persists across launches. The durable entity.
public struct CameraRecord: Hashable, Sendable, Codable, Identifiable {
  public let id: UUID            // primary key; never changes, even on rename
  public var name: String        // operator label, editable
  public var lastKnownHost: String
  public var lastSeenAt: Date
}

/// This session's association between the two.
public struct CameraBinding: Hashable, Sendable {
  public let endpoint: CameraEndpoint
  public var cameraID: UUID?     // nil == unclaimed
  public var origin: Origin      // .autoByHost, .manual, .unbound
}
```

**Why a UUID rather than keying on the name.** The name is a label the operator edits mid-game
("Cam 2" → "Third Base"). If the name were the key, every rename would orphan that camera's
archive segments and telemetry history. The UUID keeps the DVR stable through renames.

### 5.2 `SourceID` derivation

`SourceID` remains the key used by `SegmentWriter`, `ProxyStore`, `ArchiveIndex`,
`PipelineTelemetry`, `TileRouter` and `DegradationController`. Derive it from the durable
identity:

- Bound endpoint → `SourceID(record.id.uuidString)`
- Unbound endpoint → `SourceID("rtsp-\(host)")` (provisional, never enabled onto a tile;
  see 5.5)

This is strictly better than today: archives become keyed by an identity that survives IP
changes *and* app restarts, where NDI names only survived because the serial happened to be
embedded in them.

Note: existing on-device archives keyed by old NDI names become orphans. `ArchiveIndex.reconcile()`
prunes rows whose files are missing, but will not prune rows whose files still exist. Acceptable —
document it, and wipe app data before the first device run.

### 5.3 Auto-binding rules (pure functions — unit test all of these)

Put these in `CameraIdentity.swift` in `ProducerSources`, with no UI or networking imports.

```swift
public enum CameraIdentityRules {
  public static func autoBind(
    endpoints: [CameraEndpoint],
    records: [CameraRecord]
  ) -> [CameraBinding]

  public static func bind(
    endpoint: CameraEndpoint,
    to cameraID: UUID,
    in bindings: inout [CameraBinding],
    records: inout [CameraRecord],
    now: Date
  )

  public static func makeRecord(named name: String, host: String, in records: inout [CameraRecord]) -> UUID
  public static func uniqueName(_ proposed: String, in records: [CameraRecord]) -> String
  public static func forget(_ cameraID: UUID, from records: inout [CameraRecord])
}
```

Required behaviour:

1. **Auto-bind by host.** An endpoint whose `host` equals some record's `lastKnownHost` binds
   to that record with `origin == .autoByHost`. If several records claim the same host (can
   happen after IP churn), the one with the most recent `lastSeenAt` wins; the others stay
   unbound.
2. **A record binds to at most one endpoint, and an endpoint to at most one record.**
3. **Manual bind steals.** Binding endpoint B to a record already held by endpoint A unbinds A.
4. **Manual bind swaps when both are held.** If B currently holds record Y and the operator
   assigns record X (held by A) to B, then A receives Y. This is the exact remedy for two
   cameras exchanging DHCP leases, which is the most likely real-world mis-binding.
5. **Binding updates the cache.** `lastKnownHost = endpoint.host`, `lastSeenAt = now`.
6. **Names are unique**, compared case-insensitively after trimming. `uniqueName` appends
   ` 2`, ` 3`, … on collision.
7. **Forgetting** a record removes it from the cache and unbinds any endpoint holding it.

### 5.4 Persistence

New store beside the existing `SourceSelectionStore`, using the same `ConfigStore`:

```swift
public struct CameraRecordStore: Sendable {
  private static let key = "co.gamestation.producer.cameras"
  public func load() -> [CameraRecord]
  public func save(_ records: [CameraRecord])
  public func clear()
}
```

`launch.clearState` must clear this too, or Maestro flows inherit yesterday's bindings.

### 5.5 Unbound endpoints

An endpoint that matches no record shows as **Unnamed** with its IP. Enabling an unnamed camera
onto a tile auto-creates a record named `Camera N` (lowest unused N) and binds it, so the
operator is never blocked by the naming step — but the cache stays honest, because every tile
is backed by a real record.

### 5.6 Reconnect uses identity, not IP

When an RTSP session dies and the host no longer answers, the source asks discovery to re-scan.
If exactly one endpoint is unclaimed after the re-scan, rebind the record to it automatically
and carry on. If more than one is unclaimed, surface a status message and leave it to the
operator. This is the payoff of the whole model: a camera that changes IP mid-game recovers
without losing its tile, its name, or its archive continuity.

---

## 6. Module layout

`ProducerRTSP` takes the transport slot in the dependency graph, so `ProducerUI` still never
imports the transport and the app target still does the wiring.

```
Packages/ProducerRTSP/
  Package.swift
  Sources/ProducerRTSP/
    RTSPMessage.swift          request builder + response parser        (pure)
    SDPDescription.swift       SDP parse: tracks, control URLs, fmtp    (pure)
    RTSPDigestAuth.swift       Basic + Digest (MD5)                     (pure)
    RTPPacket.swift            RTP header parse, seq/timestamp          (pure)
    H264Depacketizer.swift     RFC 6184 single NAL / STAP-A / FU-A      (pure)
    HEVCDepacketizer.swift     RFC 7798 single NAL / AP / FU            (pure)
    AACDepacketizer.swift      RFC 3640 mpeg4-generic AU headers        (pure)
    VideoToolboxDecoder.swift  parameter sets → CMFormatDescription → VTDecompressionSession
    RTSPSession.swift          NWConnection state machine + keepalive
    RTSPFrameSource.swift      conforms to FrameSource
    SubnetScanner.swift        getifaddrs → CIDR → concurrent port probe
    RTSPDiscovery.swift        conforms to SourceDiscovery
```

Everything marked `(pure)` takes bytes or strings and returns values, with no networking. That
is where the test coverage lives.

Two depacketizers are required, not one: Phase 0 found the camera population is mixed (11.0).
They share a `VideoDepacketizer` protocol returning `(accessUnit: Data, isKeyframe: Bool,
rtpTimestamp: UInt32)`, so `RTSPFrameSource` selects one from the SDP `rtpmap` and is otherwise
codec-agnostic. The two differ more than the names suggest: HEVC has a **2-byte** NAL header, so
its type field is `(byte0 >> 1) & 0x3F` rather than H.264's `byte0 & 0x1F`, its aggregation and
fragmentation units are types 48 and 49 rather than 24 and 28, and its FU header carries the
start/end bits in a third byte. Do not try to fold them into one function.

`VideoToolboxDecoder` likewise needs both paths:
`CMVideoFormatDescriptionCreateFromH264ParameterSets` with SPS+PPS, and
`...FromHEVCParameterSets` with VPS+SPS+PPS. Both take parameter sets from the SDP `fmtp` line at
session start (`sprop-parameter-sets` for H.264, `sprop-vps`/`sprop-sps`/`sprop-pps` for HEVC)
and must also accept them in-band, since Phase 0 saw parameter-set NALs repeated in the stream.

### 6.1 Transport choice: TCP interleaved

`SETUP` with `Transport: RTP/AVP/TCP;unicast;interleaved=0-1`. RTP arrives on the RTSP socket
framed as `$ <channel:1> <length:2> <payload>`.

Prefer this over UDP because it needs one connection and no port allocation, it sidesteps
iOS local-network and NAT complications, and it makes loss visible as a stall rather than as
silent corruption. The cost is head-of-line blocking, which on a LAN is not a practical concern.
Keep a `rtspTransport` launch argument so UDP can be tried later without a code change.

### 6.2 Timing

Mirror `NDIFrameSource` exactly so nothing downstream changes:

- `presentationTime` — from the RTP timestamp (90 kHz for video), relative to the first packet
  of the session, as `CMTime(value: rtpDelta, timescale: 90_000)`.
- `wallClock` — `clock.now` at the moment the access unit completes.

Do **not** require RTCP sender reports in v1. They are the correct way to align a camera clock
to wall clock, but the DVR already places frames on the wall-clock timeline by arrival, exactly
as it does for NDI.

### 6.3 Statistics

`ReceiveStats` maps cleanly and must be populated, because the HUD, the Maestro assertions and
`DegradationController` all read it:

| Field | RTSP meaning |
|---|---|
| `captured` | completed access units handed to the decoder |
| `poolMisses` | no `CVPixelBuffer` available from the pool |
| `formatMisses` | undecodable / unsupported NAL type, or decode failure |
| `waitingSeconds` | time blocked reading the socket |
| `deliverySeconds` | time from access unit complete to sink return |
| `connections` | 1 after `PLAY` succeeds, 0 while reconnecting |

RTP sequence-number gaps are new information NDI never gave us. Add
`ReceiveStats.packetsLost` and surface it in the HUD — it is the one number that separates
"the network dropped it" from "the iPad could not keep up", which is the question every
degradation investigation starts with.

### 6.4 Reconnect supervision

New responsibility, because NDI's receiver self-healed and an RTSP session does not.

- No completed access unit for 5 s → tear down and reconnect.
- Backoff 1 s, 2 s, 4 s, 8 s, then hold at 8 s.
- Session keepalive: `GET_PARAMETER` (fall back to `OPTIONS` if the camera answers
  `501`) at half the `Session:` timeout, default every 30 s.
- After 3 failed reconnects, trigger the identity re-resolution described in 5.6.

---

## 7. Discovery

`RTSPDiscovery` conforms to the existing `SourceDiscovery` protocol unchanged.

Three input paths, merged and de-duplicated by `CameraEndpoint`:

1. **Subnet scan** (primary). `getifaddrs` → the Wi-Fi interface's IPv4 address and netmask →
   enumerate the CIDR, excluding network, broadcast and own address. Cap at /22 (1022 hosts)
   and refuse anything larger with a diagnostic, so a misconfigured mask cannot spawn a 65k-host
   scan. TCP-connect probe port 554 with a 300 ms timeout, 32 concurrent.
2. **Confirmation probe.** For each open 554, `OPTIONS` then `DESCRIBE` on the configured path.
   Accept only a `200` whose SDP contains a video media line. This is what stops a random
   RTSP-capable device from appearing as a camera.
3. **Manual hosts.** Comma-separated `rtspHosts` launch argument, plus a text field in Settings.
   Required for cameras on another subnet, and it is the escape hatch when a scan is blocked.

Re-scan every 15 s while the source list is on screen; stop scanning once production starts
(the scan is pure overhead during a game) except when 5.6 asks for one.

`diagnostic` string, surfaced in the HUD, e.g. `scan=192.168.1.0/24 probed=254 open=3 confirmed=3 manual=0`.

### 7.1 iOS local network permission

A raw TCP scan trips the local-network prompt on iOS 14+. Keep `NSLocalNetworkUsageDescription`.
Replace the `NSBonjourServices` entry `_ndi._tcp` with `_rtsp._tcp` — the VM33 is not known to
advertise it, but browsing a Bonjour type is what reliably raises the permission prompt, and
the existing `shared/allow-local-network.yaml` Maestro flow depends on that prompt appearing.

`NSAppTransportSecurity` needs no change; ATS governs URL loading, not raw `NWConnection`.

---

## 8. Source-list UI

`SourceSelectionView` gains the naming dropdown. Everything else in the row keeps its current
layout and accessibility identifiers so existing flows keep passing.

Row contents, left to right:

1. Presence dot (unchanged).
2. **Name control** — a `Menu`, not a plain label. Shows `record.name`, or `Unnamed` in amber.
3. Endpoint `192.168.1.37:554` in the monospaced caption slot where `selection.id.rawValue`
   is drawn today.
4. Origin badge: `AUTO` when `origin == .autoByHost`, `MANUAL` when the operator chose it,
   nothing when unbound.
5. `TILE n` badge (unchanged).
6. VIDEO / AUDIO toggles (unchanged).

Menu contents:

- `Rename…` — inline text field, the existing rename path.
- `New camera…` — creates a record with a default name and binds it.
- Divider.
- One row per cached record, showing name and `last seen 192.168.1.41`. Records currently bound
  to another *present* endpoint are still listed, with a `· in use by 192.168.1.37` suffix —
  choosing one performs the swap from 5.3 rule 4.
- Divider.
- `Forget this camera` — only when bound.

New accessibility identifiers (Maestro needs every one of these):

| Identifier | Element |
|---|---|
| `source-name-menu-{n}` | the menu button on row n |
| `camera-choice-{slug}` | a cached record row inside the menu |
| `camera-new-{n}` | "New camera…" |
| `camera-forget-{n}` | "Forget this camera" |
| `source-endpoint-{n}` | the IP:port caption |
| `source-origin-{n}` | AUTO / MANUAL badge |

Row `accessibilityValue` extends to
`name=… on=… audio=… host=… origin=…` so a flow can assert a binding without opening the menu.

---

## 9. Changes outside the new package

These are edits applied to files as they are ported in 4.4 — they arrive from `paul/ndiWip` in
their NDI-bearing form and must not reach a commit that way. Which commit of 4.5 each lands in:

| Edit | Commit |
|---|---|
| 9.2 removal of the NDI package entry and linker settings; 9.3 attribution and runtime; 9.4 usage strings; 9.5 telemetry renames; 9.6 removal of `ndiBandwidth` / `ndiExtraIps` | 1 — the scaffold |
| 9.1 `SourceKind.rtsp`; 9.2 addition of the `ProducerRTSP` package; 9.3 the `RTSPDiscovery` factory; 9.4 `_rtsp._tcp`; 9.6 the new `rtsp*` launch arguments; 9.7 control-channel commands | 3 — the transport |

Commit 1 therefore ships a `SourceKind` of just `.synthetic` and `.file`, with
`discoveryFactory` producing the synthetic discovery. That is a coherent, buildable app, not a
stub.

### 9.1 `SourceKind`

Commit 3 adds `.rtsp` to `SourceKind` and `SourceProfile` in `SourceDiscovery.swift`, taking the
slot the scaffold left with only `.synthetic` and `.file`.
`SourceProfile.default` can now be `.rtsp` on **both** simulator and device — there is no
architecture-slice problem any more, which means Maestro flows can exercise real cameras from
the simulator. Keep `.synthetic4` as the simulator default only if a reviewer prefers offline
determinism; note the choice in the commit message.

### 9.2 `project.yml`

- Drop the `ProducerNDI` package entry and both target dependencies.
- Drop `LIBRARY_SEARCH_PATHS[sdk=iphoneos*]` and `OTHER_LDFLAGS[sdk=iphoneos*]` — those exist
  solely for `libndi_ios.a`.
- Add the `ProducerRTSP` package and wire it into `Producer` and `ProducerUnitTests`.

The absence of those device-only linker settings is what lets the simulator build the real
transport, so Maestro can drive live cameras without a device build.

### 9.3 `App/ProducerApp.swift`

Drop `NDIAttribution` and `NDIRuntime`. The discovery factory becomes:

```swift
_environment = State(initialValue: AppEnvironment(
  discoveryFactory: { RTSPDiscovery(configuration: .init(from: launch), clock: clock) }
))
```

Rename the parameter `ndiDiscoveryFactory` → `discoveryFactory` in `AppEnvironment`.

### 9.4 `App/Info.plist`

- `NSBonjourServices`: `_ndi._tcp` → `_rtsp._tcp`.
- Reword `NSLocalNetworkUsageDescription`, `NSCameraUsageDescription`,
  `NSMicrophoneUsageDescription` to say RTSP cameras rather than NDI.

### 9.5 Telemetry renames

In `PipelineTelemetry.swift`: `ndiAvailable` → `sourceAvailable`, `ndiDiscovery` →
`discoveryStatus`. Add `packetsLost` to `TileTelemetry`.

These are JSON keys in `/dump-state`. Grep and update every consumer before assuming the rename
is done:

```bash
rg -n 'ndiAvailable|ndiDiscovery|ndi-unavailable' mobile/apps/gsProducer
```

Known consumers: `AppEnvironment`, `DebugHUD`, `SourceSelectionView` (the `ndi-unavailable`
identifier and the empty-state copy), `scripts/*.js`, Maestro flows.

### 9.6 Launch arguments (`LaunchConfiguration`)

| Remove | Add | Meaning |
|---|---|---|
| `ndiBandwidth` | `rtspTransport` | `tcp` (default) or `udp` |
| `ndiExtraIps` | `rtspHosts` | comma-separated manual hosts |
| | `rtspPath` | default `/live/mainstream` |
| | `rtspScan` | `false` disables the subnet scan |

Update `knownKeys` — a key missing from that array is silently ignored, which is a failure mode
that has already cost this project debugging time.

### 9.7 Control channel

Add commands so Maestro can drive binding without gestures:

- `gsproducer://test/bind-camera?index=1&name=Third%20Base`
- `gsproducer://test/forget-camera?name=Third%20Base`
- `gsproducer://test/rescan`

Follow the existing one-based-index convention used by `enable-source` and `rename-source`.

### 9.8 Paths that must not exist on `paul/gsProducer`

Nothing is "deleted" on this branch — these are simply never ported (section 4.4). Listed here
so the omission is checkable.

Tracked on `paul/ndiWip`, dropped by the `git rm` in 4.4:

```
Packages/ProducerNDI/                      (whole package, incl. Sources/CNDI)
tools/ndiRate.c
scripts/setup-ndi.sh
Tests/ProducerUnitTests/NDIDiscoveryTests.swift
maestro/flows/ndi-*.yaml                   (6 flows; reappear as rtsp-*.yaml in 10.4)
```

Untracked, so removed from the working tree only:

```
Vendor/NDI/                                (headers + libndi_ios.a; gitignored, fetched by setup-ndi.sh)
```

Referenced from files that *are* ported, so they need an edit rather than a removal: the
`setup:ndi` script in `package.json`, the `libndi_ios.a` guards in `scripts/bootstrap.sh` and
`scripts/build-device.sh`, and the `Vendor/NDI/` rule in `.gitignore`.

---

## 10. Test retention

The user requirement is that **all tests are retained** and used for final verification. Every
existing test is accounted for below.

### 10.1 Unit tests

| File | Action |
|---|---|
| `IdentifierTests.swift` | keep unchanged |
| `ScrubMappingTests.swift` | keep unchanged |
| `SourceSelectionTests.swift` | keep; retarget the kind fixture and the two fixture IDs per the 4.4 table; the assertions themselves stand |
| `NDIDiscoveryTests.swift` | not ported — the type under test does not exist here. Its intent (merging two discovery sources, deriving a display name) is re-expressed by `RTSPDiscoveryTests` and `CameraIdentityTests`, so no coverage is lost |

### 10.2 Integration tests

| File | Action |
|---|---|
| `PathsIntegrationTests.swift` | keep unchanged |

### 10.3 New unit tests (all pure, no network, no simulator)

| Suite | Covers |
|---|---|
| `RTSPMessageTests` | request formatting, CSeq increment, status-line and header parsing, multi-line folding |
| `SDPDescriptionTests` | parse a **real VM33 SDP captured in Task 0**; extract video control URL, `sprop-parameter-sets`, audio `config`, and confirm absent-audio handling |
| `RTSPDigestAuthTests` | RFC 2617 MD5 vector; Basic fallback; realm/nonce extraction |
| `RTPPacketTests` | header fields, CSRC and extension-header skipping, sequence wraparound at 65535 |
| `H264DepacketizerTests` | single NAL; STAP-A split into two NALs; FU-A reassembly across three packets; marker bit ends the access unit; sequence gap marks the AU corrupt and increments `packetsLost` |
| `AACDepacketizerTests` | AU-header-length parsing, multiple AUs per packet |
| `SubnetScannerTests` | CIDR enumeration for /24 and /22; exclusion of network, broadcast and self; refusal above /22 |
| `CameraIdentityTests` | auto-bind by host; steal; **swap**; unique naming; unbound default `Camera N`; forget unbinds; cache round-trip through `CameraRecordStore` |
| `RTSPDiscoveryTests` | merge of scan + manual hosts; de-duplication; a confirmed endpoint requires a video media line |

`CameraIdentityTests` is the most important new suite — it is the entire answer to "we have no
unique identifier", and it runs without a camera.

### 10.4 Maestro flows

The intent of every NDI flow is retained; each is recreated under an RTSP name (section 4.4
drops the originals rather than renaming them in place, so the NDI filenames never appear in
this branch's history). Copy the body from `paul/ndiWip` and repoint it:

| Source on `paul/ndiWip` | New file |
|---|---|
| `ndi-three-cameras.yaml` | `rtsp-three-cameras.yaml` |
| `ndi-four-cameras.yaml` | `rtsp-four-cameras.yaml` |
| `ndi-four-cameras-audio.yaml` | `rtsp-four-cameras-audio.yaml` |
| `ndi-full-bandwidth.yaml` | `rtsp-full-quality.yaml` |
| `ndi-no-archive-audio.yaml` | `rtsp-no-archive-audio.yaml` |
| `ndi-hevc-scrub.yaml` | `rtsp-hevc-scrub.yaml` |

In each: `sourceProfile: ndi` → `sourceProfile: rtsp`, drop `ndiBandwidth`. Flows that
reference four cameras must be reduced to three, or explicitly marked as requiring a fourth
source, since only three cameras exist.

`live.yaml`, `record-and-stop.yaml`, `program-scorebug.yaml` also carry `sourceProfile: ndi` —
repoint them too.

All `synthetic4` flows are untouched.

New flow `camera-naming.yaml` — the acceptance test for section 5:

1. Launch with `clearState: true`; assert three rows, all `Unnamed`.
2. Name each via the menu; assert `origin=manual`.
3. Relaunch; assert all three auto-bound by host with `origin=auto` and the same names.
4. Relaunch with a camera on a different IP (simulate by editing the cache through
   `bind-camera`); assert the row is `Unnamed`, open the menu, pick the cached name, assert the
   binding and that the cached `lastKnownHost` updated.
5. Deliberately mis-bind two rows, then swap them through the menu; assert both are correct.

---

## 11. Phases

Each phase ends with a green build and a green unit-test run. An agent should not begin a phase
before the previous one is green.

**Phase 0 — capture ground truth.** Before writing any client code, dump `OPTIONS`, `DESCRIBE`
and the first seconds of RTP from all three cameras. Save the SDP verbatim into
`Tests/ProducerUnitTests/Fixtures/` and use it as the `SDPDescriptionTests` fixture. Record:
codec, profile/level, packetization mode, whether audio is present, the `Session:` timeout, and
whether authentication is demanded. **Everything downstream depends on these facts; do not guess
them.**

### 11.0 Phase 0 results (measured 2026-08-18)

Cameras were found by scanning the local `/24` for an open port 554 — three hosts answered, and
no others.

| Host | Video | Profile / level | Resolution | FPS | Audio |
|---|---|---|---|---|---|
| `10.10.7.148` | **H.265** | Main, L4.0 | 1920×1080 | 30 | AAC-LC 32 kHz stereo |
| `10.10.7.225` | **H.264** | Main, L3.1 | 1280×720 | 30 | AAC-LC 32 kHz stereo |
| `10.10.7.244` | **H.265** | Main, L4.0 | 1920×1080 | 30 | AAC-LC 32 kHz stereo |

**The cameras are not identical.** This is the single most important Phase 0 finding and it
invalidates the "three identical VM33s" premise in section 2. One camera is H.264 at 720p while
the other two are H.265 at 1080p, so the client must support both codecs and must not assume a
common resolution. `10.10.7.225` also demonstrates the section 3 prerequisite going unmet: with
NDI disabled its Camera Input Quality fell back to 720p.

Everything else the plan needed to stop guessing about:

- **No authentication.** All three answer `OPTIONS` and `DESCRIBE` with `200` and no
  `WWW-Authenticate`. `RTSPDigestAuth` is therefore defensive, not load-bearing — keep it small.
- **Server**: `Hamedal Server/1.0(Jan 16 2026)`. `Public:` advertises `OPTIONS, DESCRIBE, SETUP,
  TEARDOWN, PLAY, PAUSE, ANNOUNCE, RECORD, SET_PARAMETER, GET_PARAMETER`.
- **Track layout**: `Content-Base: rtsp://<host>:554/live/mainstream/`, control `trackID=0` for
  video and `trackID=1` for audio. `a=control:*` also appears at session level and must be
  skipped when enumerating tracks.
- **Interleaved TCP works as designed**: `SETUP` echoes `interleaved=0-1` and `2-3` and returns
  an `ssrc` per track; both tracks share one `Session`.
- **Session timeout is absent** from the `Session:` header, so the RFC 2326 default of 60 s
  applies. Keepalive every 30 s via `GET_PARAMETER`, which is advertised.
- **RTCP is flowing**: sender reports (PT 200) and SDES (202) on the odd channels. Unused in v1
  but available for the A/V-sync work deferred out of 6.2.
- **No substream exists.** `/live/substream`, `/live/sub`, `/live/secondstream`,
  `/live/mainstream2` and `/live/stream1` all return `404 Stream Not Found`. Every tile must
  therefore decode the full-resolution stream; there is no cheap preview ladder to fall back on,
  which raises the stakes on the Phase 6 passthrough work.
- **Bitrate** measured ~6.4 Mbps over a 3 s interleaved capture on `10.10.7.148`, consistent with
  the camera's configured 6 Mbps.
- **Audio is real, not just declared**: decoded to 32 kHz stereo PCM. `fmtp` is
  `mode=AAC-hbr; sizelength=13; indexlength=3; indexdeltalength=3; config=1290`, i.e. AAC-LC
  32 kHz stereo, so the AU-header prefix in RFC 3640 is 2 bytes plus a 2-byte AU-headers-length.

Fixtures captured for `SDPDescriptionTests`, both verbatim including CRLF line endings:

```
Tests/ProducerUnitTests/Fixtures/vm33-h265-describe.sdp   (from 10.10.7.148)
Tests/ProducerUnitTests/Fixtures/vm33-h264-describe.sdp   (from 10.10.7.225)
```

**Phase 1 — branches and port.** Section 4 end to end: park on `paul/ndiWip`, verify, rewind
`master` to `origin/master`, cut `paul/gsProducer` from `origin/master`, port the app across
minus the paths in 9.8, and land commit 1 of 4.5. Exit criteria: the NDI sweep in 4.4 returns
nothing; `xcodegen generate` succeeds; the app builds and runs on `synthetic4` with no network
transport present; all retained tests pass.

**Phase 2 — identity, offline.** `CameraEndpoint`, `CameraRecord`, `CameraBinding`,
`CameraIdentityRules`, `CameraRecordStore`, and `CameraIdentityTests`. No networking. This
phase is fully testable in the simulator and is where the reviewer's requirement actually lives.

**Phase 3 — RTSP client.** The pure parsers first, each with its suite, then `RTSPSession`,
then `VideoToolboxDecoder`, then `RTSPFrameSource`. Exit criterion: one camera renders in one
tile with a stable frame rate for 60 s.

**Phase 4 — discovery and UI.** `SubnetScanner`, `RTSPDiscovery`, then the source-list dropdown
from section 8. Exit criterion: `camera-naming.yaml` passes.

**Phase 5 — parity and hardening.** Reconnect supervision, identity re-resolution, telemetry
renames, launch arguments, control-channel commands, doc rewrites
(`architecture.md`, `testing.md`, `risks.md`, `README.md`). Exit criterion: the full
verification sweep in section 12.

**Phase 6 — compressed passthrough archive (deferred; separate review).** With RTSP the archive
no longer needs a re-encode: feed the H.264 access units straight into an `AVAssetWriterInput`
created with `nil` output settings. That drops N encode sessions, leaving only the single
program encode. On an A12X that is the difference between three cameras being marginal and
three cameras being comfortable. It requires `SegmentWriter` to accept `CompressedFrame` — a
type that already exists in `FrameSource.swift`, reserved for exactly this. **Do not attempt
this in the same pass as Phases 1–5.** Land parity first so there is a working baseline to
compare against.

---

## 12. Final verification

Run in order. Everything must be green before the branch is offered for review.

```bash
cd /Users/paul/git/gamestation/mobile/apps/gsProducer

# 1. Project generation and build
xcodegen generate
xcodebuild -scheme Producer -destination 'platform=iOS Simulator,name=iPad Pro 11-inch' build

# 2. Full test suite — unit + integration
xcodebuild -scheme Producer -destination 'platform=iOS Simulator,name=iPad Pro 11-inch' test
```

3. Maestro, simulator, offline flows: `smoke`, `operator-*`, `scrub-*`, `export-clip`,
   `degradation-ladder`, `program-five-sources`, `hevc-scrub`.
4. Maestro, device, live flows against the three cameras: `camera-naming`,
   `rtsp-three-cameras`, `rtsp-full-quality`, `record-and-stop`, `rtsp-hevc-scrub`.
5. Artefact verification: `node scripts/verifyProgram.js` and `node scripts/verifyArchives.js`.
6. Identity soak: with the app running, reboot one camera so Starlink may hand it a different
   lease. Confirm the tile recovers, keeps its name, and continues the same archive.
7. Branch hygiene: the 4.4 sweep returns nothing (`docs/risks.md` excepted, by decision),
   `git log --oneline origin/master..paul/gsProducer` mentions NDI nowhere, and
   `git diff --stat paul/ndiWip paul/gsProducer -- mobile/apps/gsProducer` shows only intended
   differences — no non-NDI file dropped by accident during the port.

### 12.1 Reporting thermals

Any thermal figure from a device run — HUD `thermal=`, `ProcessInfo.thermalState`,
time-to-throttle, encode-session refusals, degradation-tier climbs — **must state that the
2018 iPad Pro 11" was on the Peltier cooler**, and must be recorded as a new series in
`docs/risks.md`, separate from the pre-Peltier cooling-pad and bare-device numbers. A `fair`
reading on the Peltier is not comparable to a `fair` reading in the older runs, and it is not
evidence of field thermal headroom.

---

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| ~~VM33 RTSP differs from assumptions~~ | — | **Settled by Phase 0 (11.0).** No auth, AAC audio present, standard interleaved TCP. The one surprise was the codec split |
| Mixed H.264/H.265 population | Two depacketizers and two VideoToolbox paths; a codec bug may show on only one camera | Test both fixtures in `SDPDescriptionTests`; every device run must include `10.10.7.225` (H.264) *and* an H.265 camera, never one alone |
| Mixed resolutions (1080p and 720p in the same programme) | Compositor scaling and archive dimensions vary per tile | `MetalCompositor` already scales per tile; assert both a 1080p and a 720p source in `program-five-sources`, and never hard-code 1920×1080 in the RTSP layer |
| No substream on the camera | Every tile decodes full resolution; no cheap preview ladder | Known and accepted for v1; it is the main reason Phase 6 passthrough matters |
| Hand-rolled client proves too slow to get right | Schedule | `FrameSource` is the seam; swap in FFmpeg or VLC behind it without touching the DVR |
| Subnet scan blocked or slow on the venue network | No discovery | Manual host entry is a first-class path, not a fallback |
| Starlink reassigns leases mid-game | Wrong camera on a tile | Sections 5.3 and 5.6: swap in the UI, automatic re-resolution when unambiguous |
| RTSP loses A/V sync where NDI did not | Bad archives | Keep arrival-wallclock placement identical to NDI for v1; RTCP SR alignment is a later, separate change |
| Archive orphans from old NDI-keyed `source_id` rows | Confusing timeline | Wipe app data before the first device run; note in `testing.md` |
| Only three cameras exist, but flows assume four | False failures | Reduce four-camera flows to three, or mark them as needing a fourth source |
| `git reset --hard` on `master` loses the producer work | Total loss | The three checks in 4.2 gate the reset; `paul/ndiWip` must be verified to contain `3950010` first |
| A non-NDI file is missed during the port | Silent regression late in the plan | Port the whole directory in one `git checkout`, then subtract, rather than adding files individually; diff the tree against `paul/ndiWip` at the end of Phase 1 |

---

## 14. Operation timing log

Execution of this plan must follow the `agent-operation-logs` skill.

- Path: `~/.cursor/logs/<YYYYMMDD-HHMMSS>-rtspRewrite.log` (four-digit year; create the
  directory if needed).
- First line: `RUN START <ISO-8601-with-offset>`.
- Immediately post the clickable link in chat:
  `[timing log](/Users/paul/.cursor/logs/<file>.log)`.
- Append a `START` and an `END` line for **every** task below, including a final wrap-up pair.
  Append only — never overwrite an earlier line.
- Use `NOTE` lines for asides that are not a whole task, such as the Phase 0 findings.

---

## 15. Execution todo list

```yaml
- id: timing-log
  content: FIRST action - create ~/.cursor/logs/<YYYYMMDD-HHMMSS>-rtspRewrite.log per the agent-operation-logs skill; write RUN START; send Paul the file link; log START/END for every operation including the final wrap-up
  status: pending
- id: phase-0-probe
  content: Capture OPTIONS/DESCRIBE/SDP and an RTP sample from all three VM33 cameras; save the SDP as a test fixture; record codec, packetization mode, audio presence, session timeout and auth requirement
  status: pending
- id: phase-1-branches
  content: Create paul/ndiWip and commit the current tree; verify the four producer commits are contained there; reset master hard to origin/master (a1e4697); cut paul/gsProducer from origin/master; port mobile/apps/gsProducer from paul/ndiWip omitting the section 9.8 paths; gitignore artifacts/ and drop the Vendor/NDI rule; apply the section 4.4 edit table; confirm the NDI sweep returns nothing; commit "Add GS Producer, an iPadOS live production app"; build green on synthetic4 with all retained tests passing
  status: pending
- id: phase-2-identity
  content: Implement CameraEndpoint, CameraRecord, CameraBinding, CameraIdentityRules and CameraRecordStore with full CameraIdentityTests coverage including auto-bind, steal, swap, unique naming and forget
  status: pending
- id: phase-3-client
  content: Implement the pure RTSP/SDP/auth/RTP/depacketizer layers with their test suites, then RTSPSession, VideoToolboxDecoder and RTSPFrameSource; one camera renders stably for 60 s
  status: pending
- id: phase-4-discovery-ui
  content: Implement SubnetScanner and RTSPDiscovery, then the source-list naming dropdown with all new accessibility identifiers; camera-naming.yaml passes
  status: pending
- id: phase-5-parity
  content: Reconnect supervision and identity re-resolution, telemetry renames, launch arguments, control-channel commands, Maestro flow renames, and rewrites of architecture.md, testing.md, risks.md and README.md
  status: pending
- id: verify
  content: Run the section 12 sweep - xcodegen, build, full unit and integration tests, simulator Maestro flows, device Maestro flows against three cameras, verifyProgram.js and verifyArchives.js, and the identity soak; report thermals per the Peltier rule
  status: pending
```
