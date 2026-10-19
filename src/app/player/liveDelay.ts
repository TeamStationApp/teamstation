/**
 * How far behind its newest footage a single live viewer plays, in seconds:
 * the browser's hls.js position, ExoPlayer's live offset and where AVPlayer is
 * moved on its first play. In a module of its own because the phone's files
 * cannot import the browser's.
 */
export const LIVE_DELAY_SEC = 60
