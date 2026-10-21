/**
 * A gap in a live publish that the HLS writer must not be left to write.
 *
 * A camera whose uplink stalls holds its pictures and then sends them in a
 * burst, or resumes with its timestamps tens of seconds on. Either way FFmpeg's
 * HLS writer sees one frame tens of seconds after the last, writes a segment
 * that long, and raises the playlist's `#EXT-X-TARGETDURATION` to match, for
 * the rest of the game: every player then holds back three times that far
 * behind live. The writer is ended at the gap and a new one continues the
 * playlist behind a discontinuity (`splitter.ts`).
 *
 * A jump is a video packet whose timestamp, or whose arrival, is more than
 * `cutMs` after the video packet before it: the first is a resumed stream on a
 * new clock, the second a queued burst whose timestamps still look steady.
 * Audio is not looked at, and the first packet after a reset never is one.
 */
export interface JumpDetector {
  /** A packet as it arrives; true when it is a jump. */
  feed: (packet: {
    video: boolean
    dtsMs: number
    arrivalMs: number
  }) => boolean
  /** Forgets the stream: the next video packet starts it afresh. */
  reset: () => void
}

export function jumpDetector(cutMs: number): JumpDetector {
  let last: { dtsMs: number; arrivalMs: number } | null = null
  return {
    feed: packet => {
      if (!packet.video) return false
      const before = last
      last = { dtsMs: packet.dtsMs, arrivalMs: packet.arrivalMs }
      if (before == null) return false
      return (
        Math.abs(packet.dtsMs - before.dtsMs) > cutMs ||
        packet.arrivalMs - before.arrivalMs > cutMs
      )
    },
    reset: () => {
      last = null
    }
  }
}
