# Shared receive packages

These Swift packages are the LAN camera receive stack used by more than one
GameStation app. They live here so a second app can decode the same cameras
without reaching into `gsDirector/Packages`.

| Package | What it holds |
|---------|----------------|
| `DirectorCore` | Identifiers, clock, config, SQLite wrapper, paths |
| `DirectorSources` | `FrameSource`, camera identity, advertisements, synthetic and file sources |
| `DirectorRTSP` | RTSP client, RTP depacketizers, VideoToolbox decode, AWX browse, subnet probe |

Swift module names stay `DirectorCore`, `DirectorSources`, and `DirectorRTSP`.

## Consumers

- **GS Director** — path-depends from `mobile/apps/gsDirector` for live ingest
- **GS Cameraman** — path-depends from unit tests to round-trip its packetizers
- **GS Preview** — path-depends for NearStream `/live/substream2` decode

Director-only work (program encode, DVR, UI, RTMP) stays under
`gsDirector/Packages`.
