# GS Director ↔ GS Distributor protocol

GS Director serves HTTP/1.1 on `127.0.0.1:8770` (`tsDirector/Packages/DirectorLink`). GS
Distributor reaches it over the USB-C cable: usbmuxd opens a byte pipe to that port on the iPad, and
`Packages/UsbMux`'s loopback forwarder makes it answer on a local port on the Mac. Nothing on the
Wi-Fi can connect, so there are no tokens.

Message types are in `common/DistributorWire`; JSON uses Foundation's default coding (dates are
seconds since 2001). Errors are `{"error": "<reason>"}` with the status below.

The listener only runs while GS Director is in front: it stops before the app is suspended (after
sending `directorBackgrounded` on the event stream) and starts again when it returns. `Hello.sessionID`
is new each launch, so the Mac can tell a restart, which loses the iPad's jobs, from a return to the
foreground, which does not.

## Routes

| Route | Answer |
|---|---|
| `GET /v1/hello` | `Hello`: device name, Director version, protocol version (1), install id, whether it is recording, session id |
| `GET /v1/recordings` | `[RecordingListing]`: each take with its cameras (recorded names, bytes) and the files already stitched on the iPad |
| `DELETE /v1/recordings?ids=1,2` | 200, or 409 `{refused, reason}` for the take being recorded |
| `GET /v1/recordings/{id}/manifest?tracks=primary,camera:<source id>` | `ManifestResponse`: the index rows the tracks need, the export window every file of the take is cut to, and the files to fetch. 404 for an unknown take |
| `GET /v1/recordings/{id}/still?camera=<source id>&at=<seconds>` | One JPEG (at most 640×360) of that camera about that far in. 404 when it has no picture there, 400 without a camera |
| `GET /v1/files/{archives,program,prepared}/<path>` | The file's bytes. Supports `Range: bytes=n-` for resuming. Paths never leave their root |
| `POST /v1/export-lock` | `ExportLockGranted {lockID}`: GS Director records and streams nothing until it is handed back. 409 while it records or streams |
| `PUT /v1/export-lock/{lockID}` | 200 while the lock is held; 404 once GS Director has dropped it. Renewed every 10 s: a lock left alone for about half a minute is dropped, so a Mac that dies mid-export cannot keep the iPad from recording |
| `DELETE /v1/export-lock/{lockID}` | 200. Hands the lock back |
| `POST /v1/jobs` `JobRequest` | `JobAccepted {jobID}`: the iPad stitches one track. 409 while recording |
| `DELETE /v1/jobs/{id}` | 200. The job's result is not reported |
| `GET /v1/events` | Newline-delimited `DistributorEvent`s until the connection drops: job progress, finished (with the `RemoteFile`), failed; recordings changed; recording started or stopped; Director backgrounded |
| `GET /v1/settings` | `DistributorSettings` |
| `PUT /v1/settings` `DistributorSettings` + `X-Distributor-Mac: <IOPlatformUUID>` | The merged settings: each group from whichever copy changed it last (`SettingsStamp`); a body with no stamps is taken whole. Only the sending Mac's download folder is taken from the body |

## Who keeps what

- **The iPad** keeps GS Distributor's settings (`DistributorSettingsStore`, JSON beside the index):
  a download folder per Mac, the combined-video toggle, layout and sound camera by camera name,
  and which files to upload. Every group is stamped with when and where it last changed; a group
  an older build kept and this one does not have is left unread, stamp and all.
- **The iPad's Keychain** keeps its own GameStation session, on this device only, after first
  unlock.
- **The Mac** keeps its own copy of the settings in `~/Library/Application Support/GS Distributor`,
  with the last recording list seen from each iPad and when it last met each one; its own
  GameStation session is in its Keychain. On attaching it brings the settings together (`GET`,
  then `PUT` when its copy has anything newer).

## An export

1. Files already on the Mac need nothing. When every chosen file is there, the iPad is asked for
   nothing (no lock, no manifest) and the export goes straight to steps 4 and 5, even while GS
   Director records or streams. Otherwise the Mac takes the export lock and asks for the take's
   manifest with no tracks, for the shared window.
2. Tracks already stitched on the iPad are downloaded as they are.
3. The rest are stitched on the Mac, which fetches the segments and uses the same `ExportService`.
   The iPad no longer takes a share: it is several times slower at stitching and it is the thing
   everybody is waiting for, so sharing cost more than it saved.
4. With a combined video, the Mac renders it from the saved camera files.
5. With uploads, the Mac sends each chosen file to one game on GameStation with its own account's
   session, in parts, asking first what already landed so a cut-off upload carries on where it
   stopped. Every file of a take is placed at the recording's own start, so a take's angles line up
   however far apart they were sent. The server acknowledges the finish and converts behind it; the
   Mac watches and says which part of that work is under way.
