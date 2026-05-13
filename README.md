# Gamestation game scorebug widget

Provides a dashboard and scoreboard UI web widget that can be used in
OBS or other streaming apps to overlay a score on video streams.

## Pages

- `/` - register a new event.
- `/dashboard/{eventId}` - manual overrides and engine status.
- `/scoreboard/{eventId}` - the live scoreboard widget (use this in OBS).
- `/split/{eventId}` - RTMP splitter UI: configure two destination URLs
  and stream once into the splitter; it pass-through forwards to both
  destinations (no transcoding).

## RTMP splitter

The server boots a built-in RTMP ingress on `serverConfig.rtmpPort`
(default `1935`). Publishing to `{splitterUrl}/split/{eventId}` relays
the encoded stream to both configured destinations using
`ffmpeg -c copy` (no decoding/re-encoding).

`splitterUrl` (in `serverConfig.json`) is the publicly-reachable base
URL operators use as the publish target — e.g.
`"rtmp://app.gamestation.co:1935"`. It must include the scheme and
port, no trailing slash; the application appends `/split/{eventId}`.
A server has no reliable way to detect its own public DNS name, so
this MUST be configured explicitly in production.

System requirement: `ffmpeg` must be available on `PATH`. On macOS:

```bash
brew install ffmpeg
```

On Debian / Ubuntu:

```bash
sudo apt install ffmpeg
```

A dev helper that pushes a synthetic test pattern to an arbitrary
splitter URL:

```bash
node tools/streamTestPattern.js --url rtmp://localhost:1935/split/myevent --duration 60
```
