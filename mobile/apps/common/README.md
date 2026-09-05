# Shared packages

These Swift packages are used by more than one GameStation app. They live here
so a second app can decode the same cameras, or draw the same camera screen,
without reaching into another app's `Packages`.

| Package | What it holds |
|---------|----------------|
| `DirectorCore` | Identifiers, clock, config, SQLite wrapper, paths |
| `DirectorSources` | `FrameSource`, camera identity, advertisements, synthetic and file sources |
| `DirectorRTSP` | RTSP client, RTP depacketizers, VideoToolbox decode, AWX browse, subnet probe |
| `CameramanCore` | Cameraman's pure types: zoom mapping, lenses, stream settings, format catalogue, thermal level, and the `CameraControlling` seam |
| `CameramanControlUI` | Cameraman's operating screen, Settings sheet, zoom rail and thermal pill, generic over `CameraControlling` |

Swift module names stay as listed; `CameramanCore` kept its name on the move
the way `DirectorCore` did.

## Consumers

- **GS Director** — path-depends from `mobile/apps/gsDirector` for live ingest,
  and on the Cameraman packages for the thermal pill
- **GS Cameraman** — path-depends on `CameramanCore` from every app package and
  on `CameramanControlUI` from `CameramanUI`; its unit tests also compile
  `DirectorRTSP` to round-trip the packetizers
- **GS Preview** — path-depends for NearStream `/live/substream2` decode

App-only work (Director's program encode, DVR, UI and RTMP; Cameraman's
capture, encode, server and harness) stays under each app's `Packages`.
