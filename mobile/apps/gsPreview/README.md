# GS Preview

GameStation Preview is an iPhone viewer for the cameras on the LAN. For a
NearStream it connects only to the camera’s **secondary** RTSP path so GS
Director can keep the primary stream:

```
rtsp://<camera>:554/live/substream2
```

That path is HEVC 640×360. `/live/substream` 404s. Do **not** PLAY a
NearStream's `/live/mainstream` from this app.

A GS Cameraman phone has one stream and serves any number of clients from one
encode, so it is pulled at the path it advertises (mainstream). Cameraman
cameras can also be controlled: a three-dot button on the tile opens the
phone's own operating screen — picture, thermal and battery pills, zoom rail,
flip, and Settings — driven over RTSP `GET_PARAMETER` / `SET_PARAMETER`. The
screen and Settings lay out for portrait and landscape and switch live on
rotation.

Each discovered camera is a full-width tile. The advertised name
(Bonjour instance / TXT `name`) sits on a translucent overlay at the top-left
of the video. First camera on top; later cameras append. Portrait scrolls
freely at 16:9 with 8pt gaps and a 6pt corner radius. The first tile starts
below the top safe area; scrolling can carry content under the status region
and overscroll past the bottom. Landscape thumbnails use the same top/leading
safe-area inset (the large view stays full-bleed). A green outline tracks how
much of each camera is on screen. Drag the outline to scrub the main view, or
swipe the large video; both snap to the camera occupying most of the display.
NearStream tiles have no controls. Audio is muted.

Discovery follows Director: `_awx_service._tcp` unique id (`modelname` for a
NearStream, `uuid` for a Cameraman) and a merged advertisement snapshot, so a
flaky Bonjour update does not drop a camera already seen this session.

Receive / decode lives in [`../common`](../common), shared with Director and
Cameraman, as does the Cameraman control screen (`CameramanControlUI`) and the
remote model that drives it (`CameramanRemote`). This app never imports
`gsDirector/Packages`.

## Setup

```bash
cd mobile/apps/gsPreview
socket npm run bootstrap
```

## iPhone 13 Pro

```bash
PREVIEW_DEVICE_UDID=00008110-0006098A02FA801E socket npm run build:device
PREVIEW_DEVICE_UDID=00008110-0006098A02FA801E socket npm run test:ui
```

`build-device.sh` and `run-maestro.js` print a line that names the iPhone 13 Pro
and that UDID.

## Tests

```bash
socket npm run test:unit          # iPhone 17 Pro simulator
socket npm run test:ui smoke      # Maestro on the 13 Pro
```

See [docs/testing.md](docs/testing.md).
