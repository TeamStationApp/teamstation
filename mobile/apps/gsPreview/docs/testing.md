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

Covers substream2, the NearStream / Cameraman filter (Cameraman at its
advertised mainstream), append order, advertised names, landscape snap target,
and the portrait / landscape Settings column rule.

## Maestro

```bash
PREVIEW_DEVICE_UDID=00008110-0006098A02FA801E ./scripts/build-device.sh
PREVIEW_DEVICE_UDID=00008110-0006098A02FA801E node scripts/run-maestro.js
```

The runner line names the iPhone 13 Pro UDID. Flows use `-syntheticCameras`
so `smoke` / `camera-list` / `landscape-snap` do not require the LAN. For a
live-camera check, launch without that argument on the 13 Pro (same Wi-Fi as
the VM33s).

`cameraman-control` and `cameraman-control-landscape` drive the Cameraman
control screen. `-syntheticCameras` cannot carry control, so they run against
the Node fake in `../gsDirector/scripts/fakeRtspCameras.js --cameraman "Phone 1"`
on the Mac's LAN, with the real GS Cameraman closed (it shares the iPhone):

```bash
sudo -E "$(command -v node)" ../gsDirector/scripts/fakeRtspCameras.js --cameraman "Phone 1"
PREVIEW_DEVICE_UDID=<udid> node scripts/run-maestro.js cameraman-control cameraman-control-landscape
```

## Director coexistence

With Director already on `mainstream`, open Preview and confirm tiles move
and Director does not go black. If Director is not running, PLAY
`/live/mainstream` from the Mac with ffmpeg while Preview uses `substream2`.
Do not launch Director from this worktree.
