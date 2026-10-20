/**
 * How far behind its newest footage every live viewer plays, in seconds: the
 * single player and each grid tile, by hls.js's live position, ExoPlayer's
 * live offset and where AVPlayer is moved on its first play. Long enough to
 * ride out a field's uplink catching its breath. In a module of its own
 * because the phone's files cannot import the browser's.
 */
export const LIVE_DELAY_SEC = 45
