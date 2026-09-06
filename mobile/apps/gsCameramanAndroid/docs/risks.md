# Risks and open questions

Things that are known to be true, known to be unresolved, or known to be different from the iOS
build. Kept here rather than in commit messages so the next person does not have to rediscover them.

## The identity does not survive an uninstall

**Unresolvable, not unfixed.** Android clears app storage and every Keystore entry an app owns on
uninstall, and there is no sanctioned store that outlives it. A reinstalled Cameraman is a new camera
to GS Director and has to be re-bound to its tile.

The iOS build's Keychain does survive this, so the two platforms genuinely differ in an
operator-visible way. Reinstalling a phone mid-tournament costs a re-bind on Android and does not on
iOS. `scripts/install.sh` uses `install -r`, which is an update and keeps the identity.

## The telephoto pill reads 4.1x where the stock camera app reads 5x

Both are defensible and ours is the ratio of the actual focal lengths; see `docs/capabilities.md`.
It is a cosmetic disagreement with the handset's own app, and an operator who compares the two will
notice. Resolving it properly would mean measuring the real handover point by watching
`LOGICAL_MULTI_CAMERA_ACTIVE_PHYSICAL_ID` across a zoom sweep, which is the same shape as the iOS
build's capability probe and is not yet written.

## The rotation rule has one measured anchor

`CameraSession.captureRotation` adds a quarter turn to the textbook formula because the Pixel 10's
`SurfaceTexture` transform contains one. `CaptureRenderer` measures whether the transform actually
transposes and uses that for the aspect compensation, but the rotation itself does not yet consult
that measurement — it applies the quarter turn unconditionally.

On a handset whose camera hands back a plain vertical flip, that would be 90 degrees wrong. The
measurement is already logged (`CAPTURE_TEX_MATRIX transposes=...`) and `set-rotation` exists to
establish the right value quickly, but the rule should be driven from `transformIsTransposed` rather
than from a constant. Only one handset has been measured.

## Portrait mounting is not supported

The app is landscape-only, like the iOS build, and a phone clamped in portrait will stream a sideways
picture. That is the iOS build's behaviour too — it ignores portrait angles and keeps the last
landscape one — so it is a shared product decision rather than a port defect. It is worth knowing
before mounting a rig.

## Compose reports gesture deltas where SwiftUI reports totals

`MagnifyGesture.magnification` and `DragGesture.translation` are cumulative from the moment the
gesture began. Compose's `detectTransformGestures` and `detectDragGestures` hand back only what
changed since the last event. The zoom arithmetic in `ZoomMapping` is written for the former — it is
shared with the iOS build — so `CameraScreen` accumulates the deltas before calling it.

Getting that wrong does not look like an arithmetic bug. It looks like the hardware: the picture
jerks a few pixels and springs back, and because the pills still work it reads as a zoom that is
clamped to the lens stops. Worth knowing before the next gesture is added.

A second trap in the same place: anything a `pointerInput` block closes over is frozen at the moment
that block last started, so live state has to come through `rememberUpdatedState`. A drag that seeds
itself from a stale zoom starts from the wrong place and is very hard to tell from a drag that is
merely imprecise.

## A disabled lens is a zoom clamp, and the clamp is approximate

Turning off the telephoto stops the range one hundredth of a stop below its derived switchover. That
switchover is itself derived from focal lengths rather than published, so on a handset whose real
handover sits slightly lower than the derivation says, a zoom near the ceiling could still land on
the lens the operator turned off. Measuring the true handover — by watching
`LOGICAL_MULTI_CAMERA_ACTIVE_PHYSICAL_ID` across a sweep — would settle both this and the 4.1x/5x
disagreement at once, and is not yet written.

## Silence is for the archive, not the wire

`SilenceSource` keeps one AAC access unit per 1024 samples during a recording, so a mute does not
come back as a shortened take. It is deliberately not in the live path: a muted camera has no audio
section in its SDP at all, which is the documented contract on both platforms. If Director ever wants
a continuous audio clock from a muted camera, that is a change to the contract and to both builds,
not something to switch on here alone.

## Audio and video are on separate clocks

`AudioRecord` is a separate device from the camera with its own clock, where AVFoundation gives both
to one `AVCaptureSession`. The two are aligned only by RTCP sender reports, which is what they are
for and is what every RTSP client already implements — but it does mean a client that ignores RTCP
will drift here in a way it would not on iOS. Not observed in practice with ffmpeg or Producer.

## `KEY_LEVEL` is a request, not a setting

The encoder is asked for AVC level 4.2 and puts 4.0 in the SPS. That is legal and honest — 4.0 covers
1080p30 at 6 Mbps — but it means `profile-level-id` in the SDP describes what the encoder chose
rather than what was asked for. That is the correct behaviour, since the client decides whether it
can decode from that field, but it will not match the constant in the source.

## Bitrate is CBR, and the iOS build's data-rate cap has no counterpart

`kVTCompressionPropertyKey_DataRateLimits` — a hard ceiling one second wide at 1.5x the average — has
no MediaCodec equivalent. `BITRATE_MODE_CBR` is the closest thing and is what is used. Measured
output tracked the request to within 0.01% over eight seconds, so the burst behaviour the iOS cap
guards against was not observed, but it is not *prevented* the way it is there.
