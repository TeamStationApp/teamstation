/** The same cushion as the single live hls.js viewer. */
export const LIVE_DELAY_SEC = 60

type LiveVideo = Pick<
  HTMLVideoElement,
  | 'currentTime'
  | 'paused'
  | 'seekable'
  | 'addEventListener'
  | 'removeEventListener'
>

/**
 * Native HLS may open an EVENT playlist at an earlier moment. Pick the latest
 * seekable footage on the first play, leaving the live safety cushion. Wait
 * if play precedes metadata; never reposition later plays or a manual rewind.
 * Callers omit this for a highlight link or an explicitly restored position.
 */
export function joinLiveOnFirstPlay(video: LiveVideo): () => void {
  let requested = false
  let joined = false
  const join = (): void => {
    if (!requested || joined || video.paused) return
    const ranges = video.seekable
    if (ranges.length === 0) return
    const index = ranges.length - 1
    const start = ranges.start(index)
    const end = ranges.end(index)
    if (!Number.isFinite(end) || end <= start) return
    joined = true
    video.currentTime = Math.max(start, end - LIVE_DELAY_SEC)
  }
  const play = (): void => {
    requested = true
    join()
  }
  video.addEventListener('play', play)
  const events = [
    'loadedmetadata',
    'durationchange',
    'progress',
    'canplay'
  ] as const
  for (const event of events) video.addEventListener(event, join)
  return () => {
    video.removeEventListener('play', play)
    for (const event of events) video.removeEventListener(event, join)
  }
}
