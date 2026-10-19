import { onExplicitSeek } from './explicitSeek'
import { LIVE_DELAY_SEC } from './liveDelay'

export { LIVE_DELAY_SEC }

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
  const cancel = (): void => {
    joined = true
  }
  const stopExplicitSeek = onExplicitSeek(video, cancel)
  // Browser controls seek without going through the app's seek helpers.
  // A seek following input belongs to the viewer; the engine's automatic
  // initial seek must still allow joining fresh footage on a delayed Play.
  let interacted = false
  const interact = (): void => {
    interacted = true
  }
  const seek = (): void => {
    if (interacted) cancel()
  }
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
  video.addEventListener('pointerdown', interact)
  video.addEventListener('keydown', interact)
  video.addEventListener('seeking', seek)
  const events = [
    'loadedmetadata',
    'durationchange',
    'progress',
    'canplay'
  ] as const
  for (const event of events) video.addEventListener(event, join)
  return () => {
    stopExplicitSeek()
    video.removeEventListener('play', play)
    video.removeEventListener('pointerdown', interact)
    video.removeEventListener('keydown', interact)
    video.removeEventListener('seeking', seek)
    for (const event of events) video.removeEventListener(event, join)
  }
}
