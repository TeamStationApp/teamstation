/**
 * Whether this browser can play a TeamStation video at all.
 *
 * A recording is HEVC or H.264, as its row's `codecs` says: the four-character
 * sample-entry tag (`hvc1`, `avc1`). Outside Apple's WebKit the picture reaches
 * the screen through Media Source (hls.js), so Media Source has to take that
 * codec; Chrome answers `maybe` to HLS in `canPlayType` whether or not it can
 * decode it, so that answer counts only in Apple's engine, which plays HLS
 * itself.
 *
 * The question is only whether the browser decodes the family, asked with one
 * representative type for each; the playlist's own `CODECS` still drives
 * hls.js.
 */

/** HEVC, as Media Source is asked about it. */
export const HEVC_TYPE = 'video/mp4; codecs="hvc1.1.6.L120.90"'

/** H.264, as Media Source is asked about it: High profile, level 4.0. */
export const H264_TYPE = 'video/mp4; codecs="avc1.640028"'

const HLS_TYPE = 'application/vnd.apple.mpegurl'

/**
 * The Media Source type standing for a video's codec. Every row older than
 * the tag, and every one without it, is HEVC.
 */
export function mediaSourceType(codecs?: string | null): string {
  const tag = (codecs ?? '').trim().slice(0, 4).toLowerCase()
  return tag === 'avc1' || tag === 'avc3' ? H264_TYPE : HEVC_TYPE
}

/** Whether this browser's Media Source takes the video's codec; false without one. */
export function mediaSourceTakes(codecs?: string | null): boolean {
  return (
    typeof MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported(mediaSourceType(codecs))
  )
}

export function playableHere(codecs?: string | null): boolean {
  if (mediaSourceTakes(codecs)) return true
  if (typeof navigator === 'undefined' || typeof document === 'undefined') {
    return false
  }
  return (
    navigator.vendor.includes('Apple') &&
    document.createElement('video').canPlayType(HLS_TYPE) !== ''
  )
}
