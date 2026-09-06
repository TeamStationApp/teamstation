# What this handset actually does

Measured on a **Pixel 10** (`frankel`, Android 16, API 36) on **2026-09-05**, against a stopwatch on
the bench. Everything here was read off the device or off a decoded frame; nothing was inferred from
documentation. Where a number disagrees with what an API or a spec suggests, the measurement wins and
the disagreement is written down rather than smoothed over.

## Cameras

| | Back | Front |
|---|---|---|
| Camera2 id | `0` | `1` |
| `SENSOR_ORIENTATION` | 90 | 270 |
| Physical cameras | 3 | 2 |
| `CONTROL_ZOOM_RATIO_RANGE` | 0.556 … 16.5 (capped, see below) | 0.896 … 4.0 |
| Derived switchovers | 1.0, 4.14 | 1.0 |
| Preset row on screen | 0.6x / 1x / 4.1x / 16.5x | 0.9x / 1x / 4x |

### The switchovers are derived, and 4.1x is not a typo

`AVCaptureDevice.virtualDeviceSwitchOverVideoZoomFactors` has no Camera2 counterpart. There is no API
at all that says at which zoom ratio a logical camera hands over to the next physical lens, so
`CameraSession.mapping` computes it from the optics:

1. Each physical camera's 35mm-equivalent focal length is `focal * 36 / sensorWidth`.
2. The widest of them is active at the bottom of the zoom range, by definition.
3. So the zoom at which any other lens takes over is `zoomMin * equivalent / widest`.

That lands the main lens at 1.00x, which is the correct answer and a good check on the method. It
lands the telephoto at **4.14x**, where Google's own camera app calls the same lens **5x**. Both are
defensible: 4.14 is the ratio of the actual focal lengths, and 5 is the marketing figure relative to
the main lens's *cropped* field of view. The pill row therefore reads 4.1x where the stock app reads
5x. This is a known and deliberate difference, not a rounding bug.

### The zoom ceiling is ours, not the platform's

The iOS build rejects `maxAvailableVideoZoomFactor` — 189 on an iPhone 13 Pro — in favour of
`systemRecommendedVideoZoomRange`. Android publishes no recommendation, so
`ZoomMapping.resolveMaximumDeviceZoom` is passed `null` on every call and the cap lives in
`CameraSession.mapping` instead: four times the longest real lens, which on this handset is 16.5x.
The raw `CONTROL_ZOOM_RATIO_RANGE` upper bound is higher and is almost entirely invented pixels.

## The rotation, which is the one that cost an afternoon

**The `SurfaceTexture` transform matrix contains a quarter turn.** Read off the device:

```
CAPTURE_TEX_MATRIX transposes=true 0.0,-1.0,0.0,0.0, -1.0,0.0,0.0,0.0, 0.0,0.0,1.0,0.0, 1.0,1.0,0.0,1.0
```

Column-major, that maps `(s, t)` to `(1 - t, 1 - s)` — a reflection about the anti-diagonal. The
documentation leads you to expect a plain vertical flip, and every worked example treats it as one.

Two consequences, and both were visible in decoded frames before they were understood:

**The textbook angle is 90 degrees short.** `(sensorOrientation - displayRotation)` is 0 for this
handset in landscape (sensor 90, window `ROTATION_90`), and 0 left the stopwatch lying on its side in
the encoded stream. The correction the pipeline actually needs is 90. `CameraSession.captureRotation`
adds that quarter turn, and `CaptureRotationTest` pins it.

That formula also assumes a destination in the window manager's rotated coordinate system. The
encoder's surface is a plain landscape buffer in nobody's coordinate system, and this app pins its
window to landscape, so `display.rotation` reads 90 or 270 whatever the phone is doing.

**The aspect compensation depends on the *net* of two turns.** The transform transposes and the MVP
matrix rotates back, so at 90 degrees they cancel and a 16:9 picture lands on a 16:9 buffer needing
no scaling. Compensating anyway cropped to the middle of the frame — an upright picture with a third
of the field of view, which reads as "the camera is zoomed in" rather than as a bug. `fillScale`
takes the net.

### Frames that settled it

| Rotation applied | Result |
|---|---|
| 0 (textbook) | upright scene lying on its side; stopwatch unreadable without turning your head |
| 90, aspect compensated | upright and readable, but cropped to roughly a third of the frame |
| 90, net aspect | upright, full field of view, stopwatch reads `57:57.37` |

### Front and back take the same angle

Which looks wrong and is not. The 180 degrees between a front sensor's 270 and a back sensor's 90 is
exactly cancelled by the sign flip in the standard formula. What actually separates the two cameras
is the **mirror**, and mirroring is not a rotation, so it is not modelled as one:
`CaptureRenderer.mirrorHorizontally` handles it, and it is the counterpart of the iOS build's
`connection.isVideoMirrored = false`.

Measured: before the flag, the front camera streamed upright but with `APEXEL` and `LG` reading
backwards. After it, both read correctly and the back camera was unchanged.

## Lenses

Read from the device on 2026-09-05. The millimetre labels are computed from each lens's focal length
and physical sensor size — `f = 18 / tan(fov/2)` after converting the two into a field of view — not
from a per-model table.

| Row | Position | Derived focal length | Switchover |
|---|---|---|---|
| 1 | Back | 14 mm | 0.6x (range minimum) |
| 2 | Back | 25 mm | 1x |
| 3 | Back | 105 mm | 4.1x |
| 4 | Front | 21 mm | 0.9x (range minimum) |
| 5 | Front | 24 mm | 1x |

105 / 25 is 4.2, which agrees with the 4.14x switchover derived independently from the same optics —
two routes to the same number, which is the check that the derivation is reading the hardware rather
than inventing it. It still disagrees with the 5x on the box; see the note above.

There are no native-crop rows. `secondaryNativeResolutionZoomFactors` has no Camera2 counterpart, so
where a 15 Pro lists a 48 mm 2x crop as a fourth back lens, this handset lists three. Inventing one
from a zoom ratio would be a lens that does not exist.

### Disabling a lens, measured

Turning lenses off narrows the zoom range rather than opening a different device — see the README for
why that is the only mechanism available. Measured through the control channel:

| Disabled | Preset row |
|---|---|
| none | 0.56x / 1x / 4.14x / 16.5x |
| ultra-wide and telephoto | 1x / 4.13x |
| none again | 0.56x / 1x / 4.14x / 16.5x |

The third row is the one worth having: the first implementation narrowed from the *previous* mapping
rather than from the hardware's, so every change was narrower than the last and turning a lens back
on could never widen the range again.

## Ports

| Port | Outcome |
|---|---|
| 554 | `refused: bind failed: EACCES (Permission denied)` |
| 8554 | `bound` |

Not a quirk of this handset — Linux refuses ports below 1024 to unprivileged processes, so the iOS
build's fallback path is Android's only path. The app asks for 554 anyway so that the fallback is a
recorded fact rather than a hardcoded difference between the two builds.

## Encode and stream

Measured over Wi-Fi with `scripts/rtspClient.js` from the iOS build — an independent implementation
that shares no code with either app — and then decoded by ffmpeg.

| | H.264 | HEVC |
|---|---|---|
| Frame rate | 30.12 fps | 30.12 fps |
| Bitrate | 6,000,327 bps (asked for 6,000,000) | 4,005,532 bps (asked for 4,000,000) |
| Profile in the SPS | High, level 4.0 | Main |
| Frames / keyframes in 8 s | 240 / 9 | 240 / 9 |
| Parameter sets seen | 18 (SPS+PPS per keyframe) | 27 (VPS+SPS+PPS per keyframe) |
| Sequence gaps | 0 | 0 |
| Timestamp regressions | 0 | 0 |
| RTCP sender reports | 8 | 8 |
| RTCP CNAME matches SDP | yes | yes |
| ffmpeg decode | no errors | no errors |

The level in the SPS reads 4.0 where the encoder was asked for 4.2. MediaCodec is entitled to pick a
lower level that still covers the stream, and 4.0 does cover 1080p30 at 6 Mbps, so this is the
encoder being honest rather than ignoring the request.

## Background streaming

The point of this build. Same pull, three times, with nothing else changed:

| Phase | Frame rate | Sequence gaps | Decode |
|---|---|---|---|
| Foregrounded | 30.16 fps | 0 | clean |
| Backgrounded (`KEYCODE_HOME`) | 30.16 fps | 0 | clean |
| Screen off (`mWakefulness=Dozing`) | 30.16 fps | 0 | clean |

Process state stayed `fg-service-act` throughout and the wake lock was held:

```
PARTIAL_WAKE_LOCK 'cameraman:streaming' ACQ=-1m0s293ms LONG (uid=10279)
```

The decisive evidence is not the frame rate, which a frozen stream can also hold: it is the stopwatch
in the decoded frames. Foregrounded at `57:57.37`, screen off a minute later at `58:56.75` — the
scene was still being captured, not replayed. `scripts/verifyBackground.sh` re-runs all three phases
and fails if the rate collapses, a gap appears, or the frames stop decoding.
