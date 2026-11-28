/**
 * A phone's player plays every TeamStation video, HEVC or H.264, so the
 * video's `codecs` asks nothing here.
 */
export function playableHere(_codecs?: string | null): boolean {
  return true
}
