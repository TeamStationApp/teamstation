# Measured camera capabilities

Every number here was measured, not read off a spec sheet. Regenerate with:

```bash
socket npm run capabilities
```

That writes `docs/capabilities.json` and prints a summary. The measurement needs the handset: the
simulator has no cameras at all.

**Handset:** iPhone 13 Pro (`iPhone14,2`), iOS 26.6.1, measured 2026-08-19.
A different handset will produce different numbers — an iPhone 17 Pro has a different lens set — so
treat this file as one device's readings rather than as the iPhone answer.

## How "keeps lens switching" is measured

It cannot be read off an `AVCaptureDevice.Format`. There is no property for it. The measurement sets
each format active on a running session and reads back `virtualDeviceSwitchOverVideoZoomFactors`,
which is documented to reflect the active format.

## Virtual devices

| Device | Lenses | Display multiplier | Switchovers (device zoom) | Formats | Keep switching |
|---|---|---|---|---|---|
| `builtInTripleCamera` | ultra-wide, wide, telephoto | 0.5 | 2, 6 | 51 | **51** |
| `builtInDualWideCamera` | ultra-wide, wide | 0.5 | 2 | 51 | 51 |
| `builtInDualCamera` | wide, telephoto | 1 | 3 | 51 | 51 |
| `builtInWideAngleCamera` (back) | — | 1 | — | 60 | 0 |
| `builtInUltraWideCamera` | — | 0.5 | — | 60 | 0 |
| `builtInTelephotoCamera` | — | 3 | — | 60 | 0 |
| `builtInWideAngleCamera` (front) | — | 1 | — | 56 | 0 |

The zero in the last column for the single-lens devices is not a limitation — those devices have no
constituents to switch between. It is only meaningful for the virtual devices, and there it says:

> **No format on the triple camera gives up lens switching.** All 51 keep it.

The plan had assumed 4K60 would force a single-lens fallback. It does not, because the triple camera
does not offer 4K60 at all — see the format table below. 4K60 exists only on the single-lens
wide-angle and front devices, so selecting it means selecting a different device, not degrading the
triple one.

## Triple camera: streamable formats

Deduplicated, ≥720p, ≥30 fps. `binned` formats trade resolution detail for low-light sensitivity.

| Dimensions | Frame rates | Binned | HDR |
|---|---|---|---|
| 1280x720 | 1–30 | no | yes |
| 1280x720 | 1–60 | no | yes |
| 1280x720 | 1–60 | yes | no |
| 1440x1080 | 1–60 | yes | no |
| **1920x1080** | **1–30** | no | yes |
| 1920x1080 | 1–60 | no | yes |
| 1920x1080 | 1–60 | yes | no |
| 1920x1440 | 1–30 | no | yes |
| 1920x1440 | 1–60 | no | yes |
| 2592x1944 | 1–30 | no | yes |
| 3264x2448 | 1–30 | no | yes |
| **3840x2160** | **1–30** | no | yes |
| 4032x3024 | 1–30 | no | yes |

The default, 1080p30, is the bold row. The highest 16:9 mode that keeps all three lenses is
**3840x2160@30**; the highest 16:9 frame rate is **1920x1080@60**.

120 and 240 fps exist **only** on the single-lens devices (wide-angle, ultra-wide, telephoto and
front). Offering 120 fps therefore costs lens switching, which is why `FormatCatalogue.Option`
carries a `single lens only` annotation rather than silently selecting a different device.

## Zoom, and why `maxAvailableVideoZoomFactor` is not the ceiling

`maxAvailableVideoZoomFactor` reports **189** on every device on this handset. With the triple
camera's 0.5 multiplier that is a displayed **94.5x**, almost entirely upscaled pixels, and using it
as a pinch limit would compress the useful part of the range into a few millimetres of travel. Per
format it varies between 61.875 and 189, which is no more usable.

`systemRecommendedVideoZoomRange` is Apple's own answer and is what the app uses:

| Device | Recommended device zoom | Displayed |
|---|---|---|
| `builtInTripleCamera` | 1–18 (1–30 on the 12 MP 4:3 format) | 0.5x–9x |
| `builtInDualWideCamera` | 1–6 (1–10 on 12 MP) | 0.5x–3x |
| `builtInDualCamera` | 1–9 (1–15 on 12 MP) | 1x–9x |
| `builtInWideAngleCamera` (back) | 1–3 (1–5 on 12 MP) | 1x–3x |
| `builtInUltraWideCamera` | 1–3 (1–5 on 12 MP) | 0.5x–1.5x |
| `builtInTelephotoCamera` | 1–3 (1–5 on 12 MP) | 3x–9x |
| `builtInWideAngleCamera` (front) | **none reported** | — |

The front camera reports no recommendation, so `ZoomMapping.resolveMaximumDeviceZoom` falls back to
5 — the same ceiling Apple recommends for the back wide-angle, which is the same class of
single-lens device — rather than an invented number or the 189x available maximum.

### The two zoom scales

Device zoom `1.0` is the **widest constituent**. On the triple camera that is the ultra-wide, so:

| Device zoom | Displayed | Active lens |
|---|---|---|
| 1.0 | 0.5x | ultra-wide |
| 2.0 | 1x | wide |
| 6.0 | 3x | telephoto |
| 18.0 | 9x | telephoto, digitally cropped |

The preset pills are derived from the minimum plus the switchovers, so on this handset they are
0.5x / 1x / 3x. A hardcoded `0.5 / 1 / 2 / 5` would be wrong here and on every non-Pro iPhone.

## Ports

| Port | Result |
|---|---|
| 554 | **bound** |
| 8554 | bound |

iOS applies no privileged-port restriction, so the standard RTSP port works on a handset, verified
here and with a full RTSP exchange from a Mac on the same subnet on 2026-08-19.

A first measurement reported `554: Address already in use`. The cause was a leftover
`app.teamstation.cameramanprobe` build from the device-readiness work, which auto-bound 554 on
launch. Nothing on a stock iOS install competes for the port, but **another app that wants it will
take it**, so the server has to report a bind failure as a distinct, visible state rather than
appearing to start and serving nothing.

Since 2026-09-13 the app no longer asks for 554. Both builds serve on 8554, because Android cannot
bind below 1024 and TS Director's sweep has to find every Cameraman on one port, so the probe now
measures 8554 alone.
