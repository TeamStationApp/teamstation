# What is on the wire

Exactly what this app sends, so a client that misbehaves can be checked against the intent rather
than against a reading of the source.

**It is the same wire format as the iOS build.** That is the point of the port: TS Director should
not be able to tell which platform a camera is running on, and nothing in this document differs from
`mobile/apps/tsCameraman/docs/rtsp-interop.md` except the port, a handful of read-only parameter
descriptors that Camera2 cannot fill the same way, and the measurements at the end.

## Methods

| Method | Answered with |
|---|---|
| `OPTIONS` | the list below |
| `DESCRIBE` | `application/sdp`, `Content-Base` set to the request URI |
| `SETUP` | `Transport: RTP/AVP/TCP;unicast;interleaved=n-n+1`, `Session` |
| `PLAY` | `Range: npt=now-`, `RTP-Info` with `seq` and `rtptime` per track |
| `PAUSE` | stops sending, keeps the session |
| `TEARDOWN` | responds, then closes |
| `GET_PARAMETER` | empty body is a keepalive; a `text/parameters` body reads parameters (below) |
| `SET_PARAMETER` | `text/parameters` body writes parameters; empty body is a keepalive |

`ANNOUNCE` and `RECORD` are not implemented and return `501`.

No authentication. The app is for a closed match-day network; adding a password that every operator
would have to type into every client, on a device sitting on a tripod, would cost more than it
protects.

## Transport

TCP interleaved only (RFC 2326 §10.12). A `SETUP` asking for UDP or multicast is refused with `461
Unsupported Transport` rather than quietly answered with something else.

Channels come from the client's `Transport` header. A bare `interleaved=0` implies channel 1 for
control. Where a client offers several, the first honourable one is taken — which is what ffmpeg
needs, since it offers UDP first and reads its own numbers back.

## Port

`rtsp://<phone>:8554/live/mainstream`.

Both builds serve on 8554. 554 is the registered RTSP port, but Linux will not let an unprivileged
process bind below 1024, and TS Director has to find an iPhone and an Android phone on the same port.

## SDP

```
v=0
o=- 0 0 IN IP4 0.0.0.0
s=Camera DDF1
t=0 0
a=tool:TS Cameraman
a=control:*
a=range:npt=now-
a=type:broadcast
m=video 0 RTP/AVP 96
c=IN IP4 0.0.0.0
a=rtpmap:96 H264/90000
a=control:trackID=0
a=fmtp:96 profile-level-id=640028; packetization-mode=1; sprop-parameter-sets=Z2QAKA...,aO48sA==
a=framesize:96 1920-1080
a=ssrc:305419896 cname:258bf622-da23-4f23-bbba-1b42440dddf1
a=ssrc:305419896 name:Camera DDF1
m=audio 0 RTP/AVP 97
c=IN IP4 0.0.0.0
a=rtpmap:97 mpeg4-generic/48000/1
a=control:trackID=1
a=fmtp:97 profile-level-id=1; mode=AAC-hbr; sizelength=13; indexlength=3; indexdeltalength=3; config=1188
a=ssrc:305419897 cname:258bf622-da23-4f23-bbba-1b42440dddf1
a=ssrc:305419897 name:Camera DDF1
```

The session name `s=` is the operator's camera name. The `cname` is the same string on both tracks
and the same one the RTCP SDES carries — RFC 5576 requires that, and a receiver correlating the two
has no other way to tell which camera a report belongs to.

HEVC replaces the `fmtp` line with `sprop-vps`, `sprop-sps` and `sprop-pps`, in that order, because
that is the order `CMVideoFormatDescriptionCreateFromHEVCParameterSets` wants them in on the
receiving side.

The audio section is omitted entirely when the microphone is muted, rather than announced and left
silent.

Base64 here is the JDK's, not `android.util.Base64`. The platform encoder is a stub in a JVM
unit-test process — the SDP tests would have passed against an empty `sprop-parameter-sets` — and its
default wrapping would split the attribute across two SDP lines.

## RTP

Payload type 96 for video, 97 for audio. 90 kHz video clock, sample-rate audio clock.

**H.264** (RFC 6184): single NAL units where they fit, FU-A fragmentation where they do not. The
marker bit is set on the last packet of an access unit. Maximum payload 1460 bytes.

**HEVC** (RFC 7798): the same shape with the 2-byte NAL header and fragmentation-unit type 49.

**AAC** (RFC 3640, AAC-hbr): one access unit per packet behind a 16-bit AU-headers-length field.
`sizelength=13`, `indexlength=3`, `indexdeltalength=3` — the values in the `fmtp` line, not assumed
defaults.

Video timestamps are forced to increase strictly even when the capture clock repeats a presentation
time, because a receiver ends a picture on a timestamp change and would otherwise reassemble two
frames into one malformed access unit.

Parameter sets are carried in `parameterSets` and stripped from the picture NAL units, even on
encoders that inline them ahead of every IDR. Some Android encoders do that whether or not
`KEY_PREPEND_HEADER_TO_SYNC_FRAMES` was asked for, and leaving it to chance would put SPS and PPS on
the wire twice on some handsets and once on others.

## RTCP

Compound packets every second on the control channel: a sender report (PT 200) followed by SDES
(PT 202) carrying `CNAME`, `NAME` and `TOOL`.

The sender report pairs an NTP wall clock with the RTP timestamp, which is what lets a receiver put
the video and audio clocks on a common timeline. That matters more here than on iOS: `AudioRecord` is
a separate device on a separate clock from the camera, where AVFoundation gives both to one capture
session, so RTCP is the only thing aligning them.

Receiver reports from the client are read and discarded — the sender does not adapt to them.

## Parameters

The phone is controlled over the RTSP port it already serves, with RFC 2326 §10.8–10.9
`GET_PARAMETER` / `SET_PARAMETER` and `Content-Type: text/parameters` bodies. No new port, listener
or permission. This is how TS Director and TS Preview drive a camera from its tile, and it is the
iOS build's vocabulary name for name: `core/CameraParameters.kt` is a port of
`CameramanCore/CameraParameters.swift`, and `CameraParametersTest` runs the iOS suite's fixture with
the iOS suite's expected values.

A client that wants to control the camera opens a **second, control-only** TCP connection
(`OPTIONS`, then parameters; never `SETUP`/`PLAY`) so a burst of zoom writes cannot delay RTP on the
media session. Parameters are server-level and need no `Session` header.

```
GET_PARAMETER rtsp://192.168.7.130:8554/live/mainstream RTSP/1.0
CSeq: 4
Content-Type: text/parameters
Content-Length: 3

*
```

A `GET` body lists names one per line; `*` returns the whole set. A `SET` body carries
`name: value` lines. Responses echo the values **as applied** (after clamping, after the codec's
default bitrate carried across), so the client learns what the phone actually did. A request mixing
good and bad lines applies nothing and reports the first offending name on the first line of the
body.

| Code | When |
|---|---|
| `200 OK` | applied; body echoes applied values |
| `400 Bad Request` | a value did not parse or is out of range (bitrate outside 1000–16000, unknown codec, a format the camera does not offer, disabling the last lens at a position) |
| `451 Parameter Not Understood` | unknown name (RFC 2326 §11.3.11) |
| `458 Parameter Is Read-Only` | a `SET` on a read-only name (RFC 7826 §17.4.20) |

Names follow ONVIF Media2 / PTZ configuration names so anyone who knows ONVIF reads them at sight;
the SOAP stack itself is not implemented. Lenses have no ONVIF standard. `rw` = settable.

| Name | Type | Notes |
|---|---|---|
| `device.name` | rw string | the operator name; SDP `s=`, NSD instance, RTCP NAME |
| `device.cname` | string | the UUID; same as SDP/RTCP CNAME |
| `device.model` | string | `Build.MODEL`, e.g. `Pixel 10` |
| `system.thermal` | string | `nominal` / `fair` / `serious` / `critical`, the same collapse dump-state prints |
| `system.status` | string | `running`, `recording`, … |
| `system.battery` | int | percent 0–100; empty when the handset cannot read it (an emulator) |
| `system.battery.charging` | bool | |
| `videoSource.position` | rw `back` / `front` | a change is a flip |
| `videoSource.deviceType` | string | `builtInTripleCamera (0)`: the constituent count and the Camera2 id, as dump-state names it |
| `videoSource.zoom.minimumDevice`, `.maximumDevice`, `.displayMultiplier`, `.switchOverDevice` | number / comma list | the four fields of `ZoomMapping`, so a client rebuilds the rail exactly as the phone draws it. `displayMultiplier` is always `1` here: `CONTROL_ZOOM_RATIO` is already what the operator reads |
| `ptz.zoom` | rw number | **displayed** zoom (0.5, 1, 5 …), clamped to the mapping — which is the range the lens selection left on |
| `ptz.zoom.device` | number | raw `CONTROL_ZOOM_RATIO` |
| `videoEncoder.encoding` | rw `H264` / `H265` | applied like the Settings picker, so the codec's default bitrate carries unless a rate is sent in the same request |
| `videoEncoder.resolution.width`, `.height` | rw int | with the rate, must name one offered format |
| `videoEncoder.rateControl.frameRateLimit` | rw number | fps |
| `videoEncoder.rateControl.bitrateLimit` | rw int | **kbps**, 1000–16000. With `adaptive` on, the ceiling: the stream runs at this and comes down only while a client's link backs up |
| `videoEncoder.rateControl.bitrateFloor` | rw int | **kbps**, 1000–16000 and never above `bitrateLimit`: the lowest rate adaptation may reach. A `SET` naming it is judged against the `bitrateLimit` it leaves; one naming only `bitrateLimit` brings the floor down with it rather than being refused. Half of `bitrateLimit` by default. Absent from a phone that predates it, which adapts down to half of `bitrateLimit` |
| `videoEncoder.rateControl.adaptive` | rw bool | on by default. Lowers the rate while the link to the weakest playing client backs up, never below `bitrateFloor`, and climbs back once it clears. A change is live: nothing restarts. Absent from a phone that predates it, which never adapts |
| `videoEncoder.rateControl.currentBitrate` | int | **kbps** the encoder is running at now: `bitrateLimit`, or less while adapting |
| `videoEncoder.formats` | int | count; then `format.<i>.width`, `.height`, `.frameRate`, `.multiLens` |
| `audioEncoder.enabled` | rw bool | microphone on/off |
| `audioEncoder.sampleRate` | int | 48000 |
| `lens.count` | int | then `lens.<i>.id`, `.position`, `.deviceType`, `.title`, `.displayedZoom`, `.focalLengthMM`, `.native` |
| `lens.disabled` | rw comma list of ids | a `SET` that would disable the last lens at a position is a `400`; honoured as a zoom clamp, see the README |
| `stream.url` | string | `rtsp://<ip>:<port><path>`, the string Settings copies — the bound port, so `8554` |
| `stream.clients` | int | playing sessions only; a control-only connection is not a viewer |
| `test.deliveredFrameRate` | rw number | test only: fps to deliver to the encoder, `0` for every frame (off). Captured frames are dropped before encoding, each interval varied ±30%, so the stream carries fewer, uneven frames at their own capture times; format, declared rate, SDP, session and sound are untouched. Off at every launch, never saved |
| `test.deliveredFrameRateSwing` | rw `low:high:period` | test only: the delivered rate ramps from `low` to `high` and back over each `period` seconds, starting at `low`; empty for none. Wins over `test.deliveredFrameRate` while set |
| `test.deliveredFrameRate.actual` | number | fps actually reaching the encoder over the last two seconds, throttled or not; empty until measured |

Three descriptors are filled differently from the iOS build, because Camera2 publishes different
facts. Each is read-only, and a client that only reads what the table says it means is unaffected:

- `lens.<i>.deviceType` is the Camera2 **physical camera id** (`0`, `2`, `3`) rather than an
  `AVCaptureDeviceType` name. Camera2 has no device-type vocabulary; the physical id is what it
  knows a lens by, and it is the same string the iOS build carries in `uniqueDeviceID`.
- `lens.<i>.native` is always `false`. There is no `secondaryNativeResolutionZoomFactors`, so no
  Android lens row is a native sensor crop.
- `videoSource.zoom.displayMultiplier` is always `1`, for the reason in `ZoomMapping`.

All video-encoder writes in one `SET_PARAMETER` are applied as one reconfigure, exactly like Done
on the phone. Zoom, flip and name are live. Writes are serialised on the phone; reads are not, so a
Director poll is never held behind a reconfigure.

The NSD TXT record (both `_rtsp._tcp` and `_awx_service._tcp`) carries `control=params/1`, so a
client knows before connecting that this build answers the verbs. From the Mac, with the iOS
build's script and the Android port:

```bash
npm run params -- --host <phone>                      # everything
npm run params -- --host <phone> 'ptz.zoom: 3'        # the phone's rail moves to 3x
npm run params -- --host <phone> 'videoSource.position: front'
```

## Checking it

Three independent implementations, because a hand-written client agreeing with a hand-written server
proves only that they share a misunderstanding:

1. `../tsCameraman/scripts/rtspClient.js` — a separate implementation in a different language, and
   the same one that judges the iOS build.
2. `ffprobe` and `ffmpeg` over `-rtsp_transport tcp` — genuinely independent.
3. The JVM round-trip suites, which push every packetizer's output back through a depacketizer
   written from the RFC rather than from the packetizer.

Measured on a Pixel 10, 2026-09-05: both codecs stream at 30.1 fps with no sequence gaps and no
timestamp regressions, the RTCP `CNAME` matches the SDP `a=ssrc` line, and ffmpeg decodes every
frame. See `docs/capabilities.md`.
