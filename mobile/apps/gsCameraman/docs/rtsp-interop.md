# What is on the wire

Exactly what GS Cameraman sends, so a client that misbehaves can be checked against the intent
rather than against a reading of the source.

## Methods

| Method | Answered with |
|---|---|
| `OPTIONS` | the list below |
| `DESCRIBE` | `application/sdp`, `Content-Base` set to the request URI |
| `SETUP` | `Transport: RTP/AVP/TCP;unicast;interleaved=n-n+1`, `Session` |
| `PLAY` | `Range: npt=0.000-`, `RTP-Info` with `seq` and `rtptime` per track |
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
control. Where a client offers several, the first honourable one is taken.

## SDP

```
v=0
o=- 0 0 IN IP4 0.0.0.0
s=Third Base
t=0 0
a=control:*
m=video 0 RTP/AVP 96
a=rtpmap:96 H264/90000
a=fmtp:96 packetization-mode=1; profile-level-id=640028; sprop-parameter-sets=Z2QAKA...,aO48sA==
a=control:trackID=0
a=ssrc:305419896 cname:c94df9ca-d7c2-468f-8529-97d01fba14e7
m=audio 0 RTP/AVP 97
a=rtpmap:97 mpeg4-generic/48000/1
a=fmtp:97 streamtype=5; profile-level-id=1; mode=AAC-hbr; config=1188; sizeLength=13; indexLength=3; indexDeltaLength=3
a=control:trackID=1
a=ssrc:305419897 cname:c94df9ca-d7c2-468f-8529-97d01fba14e7
```

The session name `s=` is the operator's camera name. The `cname` is the same string on both tracks
and the same one the RTCP SDES carries — RFC 5576 requires that, and a receiver correlating the two
has no other way to tell which camera a report belongs to.

HEVC replaces the `fmtp` line with `sprop-vps`, `sprop-sps` and `sprop-pps`, in that order, because
that is the order `CMVideoFormatDescriptionCreateFromHEVCParameterSets` wants them in.

The audio section is omitted entirely when the microphone is muted, rather than announced and left
silent.

## RTP

Payload type 96 for video, 97 for audio. 90 kHz video clock, sample-rate audio clock.

**H.264** (RFC 6184): single NAL units where they fit, FU-A fragmentation where they do not. The
marker bit is set on the last packet of an access unit. Maximum payload 1460 bytes.

**HEVC** (RFC 7798): the same shape with the 2-byte NAL header and fragmentation-unit type 49.

**AAC** (RFC 3640, AAC-hbr): one access unit per packet behind a 16-bit AU-headers-length field.
`sizeLength=13`, `indexLength=3`, `indexDeltaLength=3` — the values in the `fmtp` line, not
assumed defaults.

Video timestamps are forced to increase strictly even when the capture clock repeats a presentation
time, because a receiver ends a picture on a timestamp change and would otherwise reassemble two
frames into one malformed access unit.

## RTCP

Compound packets every second on the control channel: a sender report (PT 200) followed by SDES
(PT 202) carrying `CNAME` and `NAME`.

The sender report pairs an NTP wall clock with the RTP timestamp, which is what lets a receiver put
the video and audio clocks on a common timeline. Receiver reports from the client are read and
discarded — the sender does not adapt to them.

## Parameters

The phone is controlled over the RTSP port it already serves, with RFC 2326 §10.8–10.9
`GET_PARAMETER` / `SET_PARAMETER` and `Content-Type: text/parameters` bodies. No new port, listener
or permission. A client that wants to control the camera opens a **second, control-only** TCP
connection (`OPTIONS`, then parameters; never `SETUP`/`PLAY`) so a burst of zoom writes cannot delay
RTP on the media session. Parameters are server-level and need no `Session` header.

```
GET_PARAMETER rtsp://10.10.7.118:554/live/mainstream RTSP/1.0
CSeq: 4
Content-Type: text/parameters
Content-Length: 2

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
| `400 Bad Request` | a value did not parse or is out of range (bitrate outside 1000–50000, unknown codec, a format the camera does not offer, disabling the last lens at a position) |
| `451 Parameter Not Understood` | unknown name (RFC 2326 §11.3.11) |
| `458 Parameter Is Read-Only` | a `SET` on a read-only name (RFC 7826 §17.4.20) |

Names follow ONVIF Media2 / PTZ configuration names so anyone who knows ONVIF reads them at sight;
the SOAP stack itself is not implemented. Lenses have no ONVIF standard. `rw` = settable.

| Name | Type | Notes |
|---|---|---|
| `device.name` | rw string | the operator name; SDP `s=`, Bonjour instance, RTCP NAME |
| `device.cname` | string | the UUID; same as SDP/RTCP CNAME |
| `device.model` | string | `iPhone14,2` |
| `system.thermal` | string | `nominal` / `fair` / `serious` / `critical`, the same name dump-state prints |
| `system.status` | string | `running`, `recording`, … |
| `system.battery` | int | percent 0–100; empty when the phone cannot read it |
| `system.battery.charging` | bool | |
| `videoSource.position` | rw `back` / `front` | a change is a flip |
| `videoSource.deviceType` | string | active `AVCaptureDevice.DeviceType` |
| `videoSource.zoom.minimumDevice`, `.maximumDevice`, `.displayMultiplier`, `.switchOverDevice` | number / comma list | the four fields of `ZoomMapping`, so a client rebuilds the rail exactly as the phone draws it |
| `ptz.zoom` | rw number | **displayed** zoom (0.5, 1, 3 …), clamped to the mapping |
| `ptz.zoom.device` | number | raw device factor |
| `videoEncoder.encoding` | rw `H264` / `H265` | applied like the Settings picker, so the codec's default bitrate carries unless a rate is sent in the same request |
| `videoEncoder.resolution.width`, `.height` | rw int | with the rate, must name one offered format |
| `videoEncoder.rateControl.frameRateLimit` | rw number | fps |
| `videoEncoder.rateControl.bitrateLimit` | rw int | **kbps**, 1000–50000 |
| `videoEncoder.formats` | int | count; then `format.<i>.width`, `.height`, `.frameRate`, `.multiLens` |
| `audioEncoder.enabled` | rw bool | microphone on/off |
| `audioEncoder.sampleRate` | int | 48000 |
| `lens.count` | int | then `lens.<i>.id`, `.position`, `.deviceType`, `.title`, `.displayedZoom`, `.focalLengthMM`, `.native` |
| `lens.disabled` | rw comma list of ids | a `SET` that would disable the last lens at a position is a `400` |
| `stream.url` | string | `rtsp://<ip>:<port><path>`, the string Settings copies |
| `stream.clients` | int | playing sessions only; a control-only connection is not a viewer |

All video-encoder writes in one `SET_PARAMETER` are applied as one reconfigure, exactly like Done
on the phone. Zoom, flip and name are live.

The Bonjour TXT record (both `_rtsp._tcp` and `_awx_service._tcp`) carries `control=params/1`, so
a client knows before connecting that this build answers the verbs. From the Mac:

```bash
node scripts/rtspParams.js --host <phone>                 # everything
node scripts/rtspParams.js --host <phone> 'ptz.zoom: 3'   # the phone's rail moves to 3x
```

## Checking it

Three independent implementations, because a hand-written client agreeing with a hand-written server
proves only that they share a misunderstanding:

1. `scripts/rtspClient.js` — a separate implementation in a different language.
2. `ffprobe` and `ffmpeg` over `-rtsp_transport tcp` — genuinely independent.
3. The Swift round-trip suites, which push our packetizer output through **GS Producer's own**
   depacketizers, compiled into the test target through an SPM path dependency.

```bash
# our client, then ffmpeg over the same stream
socket npm run verify:stream
ffmpeg -rtsp_transport tcp -i rtsp://<phone>:554/live/mainstream -t 6 -c copy out.mp4
```

Measured on an iPhone 13 Pro, 2026-08-19: both codecs stream at 30 fps with no sequence gaps, the
RTCP `CNAME` matches the SDP `a=ssrc` line, and ffmpeg decodes every frame. See `docs/risks.md`.
