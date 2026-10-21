/**
 * Whether this browser can play TeamStation's video at all.
 *
 * The recordings are HEVC. Outside Apple's WebKit they reach the picture
 * through Media Source (hls.js), so Media Source has to take HEVC; Chrome
 * answers `maybe` to HLS in `canPlayType` whether or not it can decode it, so
 * that answer counts only in Apple's engine, which plays HLS itself.
 */

/** The video's codec, as Media Source is asked about it. */
export const HEVC_TYPE = 'video/mp4; codecs="hvc1.1.6.L120.90"'

const HLS_TYPE = 'application/vnd.apple.mpegurl'

export function playableHere(): boolean {
  if (
    typeof MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported(HEVC_TYPE)
  ) {
    return true
  }
  if (typeof navigator === 'undefined' || typeof document === 'undefined') {
    return false
  }
  return (
    navigator.vendor.includes('Apple') &&
    document.createElement('video').canPlayType(HLS_TYPE) !== ''
  )
}
