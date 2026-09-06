# What is on the wire

Exactly what this app sends, so a client that misbehaves can be checked against the intent rather
than against a reading of the source.

**It is the same wire format as the iOS build.** That is the point of the port: GS Producer should
not be able to tell which platform a camera is running on, and nothing in this document differs from
`mobile/apps/gsCameraman/docs/rtsp-interop.md` except the port and the measurements at the end.

## Methods

| Method | Answered with |
|---|---|
| `OPTIONS` | the list below |
| `DESCRIBE` | `application/sdp`, `Content-Base` set to the request URI |
| `SETUP` | `Transport: RTP/AVP/TCP;unicast;interleaved=n-n+1`, `Session` |
| `PLAY` | `Range: npt=now-`, `RTP-Info` with `seq` and `rtptime` per track |
| `PAUSE` | stops sending, keeps the session |
| `TEARDOWN` | responds, then closes |
| `GET_PARAMETER` | empty body, used as a keepalive |

`ANNOUNCE`, `RECORD` and `SET_PARAMETER` are not implemented and return `501`.

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

554 is requested first and always refused: Linux will not let an unprivileged process bind below
1024, so on Android the iOS build's fallback is the only path. Both numbers are visible on the
settings screen and in `dump-state`, because an operator reading "554" off an iPhone next to this
handset needs to know why the two differ before typing the wrong address into Producer.

## SDP

```
v=0
o=- 0 0 IN IP4 0.0.0.0
s=Camera DDF1
t=0 0
a=tool:GS Cameraman
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

## Checking it

Three independent implementations, because a hand-written client agreeing with a hand-written server
proves only that they share a misunderstanding:

1. `../gsCameraman/scripts/rtspClient.js` — a separate implementation in a different language, and
   the same one that judges the iOS build.
2. `ffprobe` and `ffmpeg` over `-rtsp_transport tcp` — genuinely independent.
3. The JVM round-trip suites, which push every packetizer's output back through a depacketizer
   written from the RFC rather than from the packetizer.

Measured on a Pixel 10, 2026-09-05: both codecs stream at 30.1 fps with no sequence gaps and no
timestamp regressions, the RTCP `CNAME` matches the SDP `a=ssrc` line, and ffmpeg decodes every
frame. See `docs/capabilities.md`.
