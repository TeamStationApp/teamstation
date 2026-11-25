/**
 * How every device encodes a reel: H.264 at 30 frames a second and 1 Mbit/s,
 * with AAC sound at 128 kbit/s, which keeps a 15-second reel inside the
 * server's 1.7 Mbit/s and 3.2 MB limits.
 */
export const REEL_ENCODING = {
  codec: 'avc',
  frameRate: 30,
  videoBitrate: 1_000_000,
  audioBitrate: 128_000
} as const
