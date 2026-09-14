# GS Director ↔ GS Distributor protocol

GS Director serves HTTP/1.1 on `127.0.0.1:8770` (`gsDirector/Packages/DirectorLink`). GS
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
| `POST /v1/jobs` `JobRequest` | `JobAccepted {jobID}`: the iPad stitches one track. 409 while recording |
| `DELETE /v1/jobs/{id}` | 200. The job's result is not reported |
| `GET /v1/events` | Newline-delimited `DistributorEvent`s until the connection drops: job progress, finished (with the `RemoteFile`), failed; recordings changed; recording started or stopped; Director backgrounded |
| `GET /v1/settings` | `DistributorSettings` |
| `PUT /v1/settings` `DistributorSettings` + `X-Distributor-Mac: <IOPlatformUUID>` | The merged settings. Only the sending Mac's download folder is taken from the body |
| `POST /v1/peertube/signin` `PeerTubeSignIn` | `PeerTubeSignInResult`: `signedIn(account)` or `otpRequired`. 400 for a missing host or user name, 401 for a refused sign-in or a host that is not PeerTube, 502 when PeerTube cannot be reached |
| `GET /v1/peertube/token` | `PeerTubeToken`: host, user name, an access token with five minutes or more left, and when it expires. 401 when not signed in |
| `POST /v1/peertube/signout` | 200. The token is revoked (best effort) and the account forgotten |

## Who keeps what

- **The iPad** keeps GS Distributor's settings (`DistributorSettingsStore`, JSON beside the index):
  a download folder per Mac, the combined-video toggle, layout and sound camera by camera name, and
  PeerTube's host, user name, the channel and privacy last uploaded with, and which files to upload.
- **The iPad's Keychain** keeps the PeerTube account (this device only, after first unlock): the
  instance's OAuth client and the tokens. Never the password. The refresh token never leaves it.
- **The Mac** keeps nothing between launches.

## An export

1. The Mac asks for the take's manifest with no tracks, for the shared window.
2. Tracks already stitched on the iPad are downloaded as they are.
3. The rest are split: the first to the Mac, which fetches the segments and stitches with the same
   `ExportService`; the second to the iPad as a job; then whichever is free takes the next. The iPad
   takes nothing new while it records, and a job it refuses with 409 goes back to the Mac.
4. With a combined video, the Mac renders it from the saved camera files.
5. With uploads, the Mac uploads each chosen file to PeerTube with a token from `/v1/peertube/token`,
   fetched again whenever the one it holds has under five minutes left.
