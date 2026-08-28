# GS Preview

GameStation Preview is an iPhone viewer for NearStream cameras on the LAN. It
connects only to the camera’s **secondary** RTSP path so GS Director can keep
the primary stream:

```
rtsp://<camera>:554/live/substream2
```

That path is HEVC 640×360. `/live/substream` 404s. Do **not** PLAY
`/live/mainstream` from this app.

Each discovered NearStream camera is a full-width tile. The advertised name
(Bonjour instance / TXT `name`) sits on a translucent overlay at the top-left
of the video. First camera on top; later cameras append. Portrait scrolls
freely at 16:9 with 8pt gaps and a 6pt corner radius. The first tile starts
below the top safe area; scrolling can carry content under the status region
and overscroll past the bottom. Landscape thumbnails use the same top/leading
safe-area inset (the large view stays full-bleed). A green outline tracks how
much of each camera is on screen. Drag the outline to scrub the main view, or
swipe the large video; both snap to the camera occupying most of the display.
There are no camera controls. Audio is muted.

Discovery follows Director: `_awx_service._tcp` unique id (`modelname`) and a
merged advertisement snapshot, so a flaky Bonjour update does not drop a
camera already seen this session.

Receive / decode lives in [`../common`](../common), shared with Director and
Cameraman. This app never imports `gsDirector/Packages`.

## Setup

```bash
cd mobile/apps/gsPreview
socket npm run bootstrap
```

## iPhone 13 Pro

```bash
PREVIEW_DEVICE_UDID=22222222-2222222222222222 socket npm run build:device
PREVIEW_DEVICE_UDID=22222222-2222222222222222 socket npm run test:ui
```

`build-device.sh` and `run-maestro.js` print a line that names the iPhone 13 Pro
and that UDID.

## Tests

```bash
socket npm run test:unit          # iPhone 17 Pro simulator
socket npm run test:ui smoke      # Maestro on the 13 Pro
```

See [docs/testing.md](docs/testing.md).
