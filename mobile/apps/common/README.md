# Shared packages

These Swift packages are used by more than one GameStation app. They live here
so a second app can decode the same cameras, or draw the same camera screen,
without reaching into another app's `Packages`.

| Package | What it holds |
|---------|----------------|
| `DirectorCore` | Identifiers, clock, config, SQLite wrapper, paths |
| `DirectorExport` | The archive index (`ArchiveIndex`) and the export that stitches a recording's segments into finished files (`ExportService`, `SegmentAssembler`, `ArchiveRemux`, `RecordingExport`), plus archive retention. iOS and macOS, so the Mac stitches exactly as the iPad does |
| `DirectorSources` | `FrameSource`, camera identity, advertisements, synthetic and file sources |
| `DirectorRTSP` | RTSP client, RTP depacketizers, VideoToolbox decode, AWX browse, subnet probe |
| `CameramanCore` | Cameraman's pure types: zoom mapping, lenses, stream settings, format catalogue, thermal level, and the `CameraControlling` seam |
| `CameramanControlUI` | Cameraman's operating screen, Settings sheet, zoom rail, thermal and battery pills, generic over `CameraControlling` |
| `CameramanRemote` | `RemoteCameraControl`: `CameraControlling` over RTSP `GET_PARAMETER` / `SET_PARAMETER`, polling at 1 Hz with coalesced writes |

Swift module names stay as listed; `CameramanCore` kept its name on the move
the way `DirectorCore` did.

## Consumers

- **GS Director** — path-depends from `mobile/apps/gsDirector` for live ingest,
  and on the Cameraman packages for the thermal pill. `DirectorDVR` re-exports
  `DirectorExport`; any target that calls the export itself depends on
  `DirectorExport` directly, because static linking only carries the objects
  `DirectorDVR` uses
- **GS Cameraman** — path-depends on `CameramanCore` from every app package and
  on `CameramanControlUI` from `CameramanUI`; its unit tests also compile
  `DirectorRTSP` to round-trip the packetizers
- **GS Preview** — path-depends for NearStream `/live/substream2` decode

App-only work (Director's program encode, DVR, UI and RTMP; Cameraman's
capture, encode, server and harness) stays under each app's `Packages`.
