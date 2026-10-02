# Architecture

```
AWXServiceBrowser (_awx_service._tcp)
  │  keep NearStream (modelname VM33*) and Cameraman (uuid); drop the rest
  ▼
NearStream: CameraEndpoint(host, 554, /live/substream2)   # TXT path is ignored
Cameraman:  the advertised endpoint (mainstream)
  │  RTSPEndpointProbe DESCRIBE
  ▼
RTSPFrameSource (DirectorRTSP in mobile/apps/common)
  │  PixelFrame, no audio sink
  ▼
PreviewRenderer → AVSampleBufferDisplayLayer

Cameraman tile ⋮ → CameraControlScreen (CameramanControlUI)
  │  RemoteCameraControl (CameramanRemote): GET_PARAMETER * at 1 Hz,
  │  SET_PARAMETER on zoom / flip / Done, on a second control-only connection
  ▼
the phone's RTSP port
```

TS Preview path-depends on `mobile/apps/common/{DirectorCore,DirectorSources,DirectorRTSP,
CameramanCore,CameramanControlUI,CameramanRemote}` only. It does not build the Director app and
does not import DirectorPipeline, DirectorDVR, DirectorRTMP, or DirectorUI.

`PreviewStream.nearStreamPath` is `/live/substream2`. A 404 skips that camera.
There is no mainstream fallback for a NearStream. A Cameraman advertises
`control=params/1` when it answers the parameter verbs; only then does its tile
get the three-dot button.

The control screen is Cameraman's own `CameraView`, generic over
`CameraControlling`. On this phone-sized, rotating display the picture is
aspect-fit and the chrome pins to the screen edges; `SettingsView` lays its
cards out in one column in portrait and two in landscape (`SettingsLayout`),
keeping the draft above the layout switch so a rotation mid-edit loses nothing.

Tile order is discovery-append (`PreviewCameraRules.merging`). Tiles use the
same identity Director does: `_awx_service._tcp` `modelname` unique id. Browse
snapshots are merged (`remembering`) so a Bonjour glitch that omits one
instance does not drop a camera this session already saw. The advertised name
overlays the top-left of the 16:9 video. Portrait tiles are 16:9 from the
display width. Landscape puts live scrolling thumbnails on the left (green
border on the focused camera) and a full-height 16:9 view beside them. Tiles
use a 6pt corner radius with 8pt gaps.
