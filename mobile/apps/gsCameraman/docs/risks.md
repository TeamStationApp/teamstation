# Risk log

What was assumed, what was measured, and what is still open. Dated entries so a later reading knows
which hardware and which OS produced a number.

## Resolved by measurement

### Port 554 binds on a handset — 2026-08-19, iPhone 13 Pro, iOS 26.6.1

iOS applies no privileged-port restriction. 554 binds, and a full RTSP exchange from a Mac on the
same subnet completed against it.

A first measurement reported `Address already in use`, caused by a leftover
`co.gamestation.cameramanprobe` build from the device-readiness work that auto-bound 554 on launch.
Nothing on a stock iOS install competes for the port, but another app that wants it will take it, so
a bind failure has to be a visible state with a fallback to 8554 rather than a server that appears to
start and serves nothing.

The simulator has not been confirmed to bind 554, which is why `StreamSettings.fallbackPort` exists.

### Bonjour needs an `Info.plist` declaration — 2026-08-19

Advertising `_rtsp._tcp` without listing it under `NSBonjourServices` fails with `-65555`
(`kDNSServiceErr_NoAuth`) and takes the whole `NWListener` down with it. `NSLocalNetworkUsageDescription`
alone is not sufficient.

### No format on the triple camera gives up lens switching — 2026-08-19, iPhone 13 Pro

All 51 formats keep it. The plan had assumed 4K60 would force a single-lens fallback; the triple
camera does not offer 4K60 at all. 120 and 240 fps do cost lens switching, because they exist only on
the single-lens devices. See `docs/capabilities.md`.

### The zoom ceiling is not `maxAvailableVideoZoomFactor` — 2026-08-19, iPhone 13 Pro

That property reports **189** on every device on this handset, a displayed 94.5x of upscaled pixels.
`systemRecommendedVideoZoomRange` reports 1–18 for the triple camera's video formats, i.e. 0.5x–9x
displayed, and is what the app uses. The front camera reports no recommendation at all and falls back
to 5.

### Maestro cannot see system permission alerts on device — 2026-08-19

They sit outside the app's accessibility hierarchy, so `tapOn: "Allow"` finds nothing while the dialog
is plainly on screen. They must be tapped by coordinate; the measured percentages are in
`maestro/flows/shared/allow-permissions.yaml`.

### maestro-runner terminates the app before every flow — 2026-08-19

Even a flow with no `launchApp`. A `devicectl ... --console` session started first is killed with
signal 9, so permission-granting has to happen **before** the console launch, not after. This is why
`scripts/capabilities.sh` runs the Maestro flow first.

## Open

### A different handset will read differently

Every capability number is from one iPhone 13 Pro. An iPhone 17 Pro has a different lens set and
format list. `scripts/common.sh` resolves whichever iPhone is connected, so a reading can silently
come from the wrong phone; the model identifier is recorded in `docs/capabilities.json` for that
reason.

### Thermals under sustained encode are unmeasured

No sustained-stream run has been done yet, so nothing is known about how long the phone holds 1080p30
before throttling, or what 4K30 costs. Unlike the iPad in `../gsProducer/docs/risks.md`, this handset
is not sitting on a Peltier cooler.

### The simulator has no camera

Anything touching `AVCaptureSession` is verifiable only on the handset. The synthetic camera source
in `CameramanTestHarness` exists so the encode and wire layers can still be exercised without one.
