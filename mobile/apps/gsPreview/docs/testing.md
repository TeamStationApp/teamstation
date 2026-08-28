# Testing

## Device

iPhone 13 Pro, iOS 26.6.1, hardware UDID `00008110-0006098A02FA801E`.
Default simulator: `iPhone 17 Pro`.

Do not install or Maestro either Director iPad from this app.

## Unit

```bash
cd mobile/apps/gsPreview
socket npm run bootstrap
PREVIEW_SIMULATOR_UDID=<udid> ./scripts/test-unit.sh
```

Covers substream2, NearStream-only filter, append order, advertised names,
landscape snap target.

## Maestro

```bash
PREVIEW_DEVICE_UDID=00008110-0006098A02FA801E ./scripts/build-device.sh
PREVIEW_DEVICE_UDID=00008110-0006098A02FA801E node scripts/run-maestro.js
```

The runner line names the iPhone 13 Pro UDID. Flows use `-syntheticCameras`
so `smoke` / `camera-list` / `landscape-snap` do not require the LAN. For a
live-camera check, launch without that argument on the 13 Pro (same Wi-Fi as
the VM33s).

## Director coexistence

With Director already on `mainstream`, open Preview and confirm tiles move
and Director does not go black. If Director is not running, PLAY
`/live/mainstream` from the Mac with ffmpeg while Preview uses `substream2`.
Do not launch Director from this worktree.
