# Architecture

```
AWXServiceBrowser (_awx_service._tcp)
  │  keep NearStream (modelname VM33*); drop Cameraman
  ▼
CameraEndpoint(host, 554, /live/substream2)   # TXT path is ignored
  │  RTSPEndpointProbe DESCRIBE
  ▼
RTSPFrameSource (DirectorRTSP in mobile/apps/common)
  │  PixelFrame, no audio sink
  ▼
PreviewRenderer → AVSampleBufferDisplayLayer
```

GS Preview path-depends on `mobile/apps/common/{DirectorCore,DirectorSources,DirectorRTSP}`
only. It does not build the Director app and does not import DirectorPipeline,
DirectorDVR, DirectorRTMP, or DirectorUI.

`PreviewStream.nearStreamPath` is `/live/substream2`. A 404 skips that camera.
There is no mainstream fallback.

Tile order is discovery-append (`PreviewCameraRules.merging`). Tiles use the
same identity Director does: `_awx_service._tcp` `modelname` unique id. Browse
snapshots are merged (`remembering`) so a Bonjour glitch that omits one
instance does not drop a camera this session already saw. The advertised name
overlays the top-left of the 16:9 video. Portrait tiles are 16:9 from the
display width. Landscape puts live scrolling thumbnails on the left (green
border on the focused camera) and a full-height 16:9 view beside them. Tiles
use a 6pt corner radius with 8pt gaps.
