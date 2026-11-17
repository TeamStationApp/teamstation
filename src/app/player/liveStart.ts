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

/** The clock the cushion is kept on, replaceable in a test. */
export interface CushionClock {
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

const cushionClock: CushionClock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  }
}

/** How far short of its cushion a live player may fall before it is moved. */
export const CUSHION_SLACK_SEC = 10

/**
 * Keeps Safari's own player `LIVE_DELAY_SEC` behind the newest footage after
 * the stream has been away.
 *
 * While a camera's publisher is cut the playlist stops growing and the player
 * plays its cushion away; when it comes back, the footage carries on from
 * where it left off and nothing gives that cushion back. Measured on an
 * iPhone: four cuts of 4, 8, 16 and 32 s took it from 58 s behind to 7.5 s,
 * and a 64 s cut after them ran it dry. hls.js holds its own live position;
 * WebKit's player does not.
 *
 * So once the end of what it can reach moves on again — the stream is back —
 * a player that has fallen more than `CUSHION_SLACK_SEC` short of its cushion
 * is put back to it. Never during an outage, when moving back would only
 * replay what it has and run dry again; never while paused or seeking. A
 * viewer's own seek sets the cushion to where it lands, up to
 * `LIVE_DELAY_SEC`, so a rewind is never pulled about and a jump towards the
 * newest footage is kept.
 */
export function keepLiveCushion(
  video: LiveVideo,
  wantsToPlay: () => boolean,
  clock: CushionClock = cushionClock
): () => void {
  let cushion = LIVE_DELAY_SEC
  let rebase = false
  let interacted = false
  let lastEnd: number | null = null
  let timer: unknown
  const stopExplicitSeek = onExplicitSeek(video, () => {
    rebase = true
  })
  const interact = (): void => {
    interacted = true
  }
  const seek = (): void => {
    if (interacted) rebase = true
    interacted = false
  }
  const tick = (): void => {
    const ranges = video.seekable
    const index = ranges.length - 1
    const end = index < 0 ? NaN : ranges.end(index)
    if (Number.isFinite(end) && !video.paused && wantsToPlay()) {
      const behind = end - video.currentTime
      if (rebase) {
        rebase = false
        cushion = Math.min(LIVE_DELAY_SEC, Math.max(0, behind))
      } else if (
        lastEnd != null &&
        end > lastEnd + 0.5 &&
        behind < cushion - CUSHION_SLACK_SEC
      ) {
        video.currentTime = Math.max(ranges.start(index), end - cushion)
      }
    }
    lastEnd = Number.isFinite(end) ? end : null
    timer = clock.setTimeout(tick, 1000)
  }
  video.addEventListener('pointerdown', interact)
  video.addEventListener('keydown', interact)
  video.addEventListener('seeking', seek)
  timer = clock.setTimeout(tick, 1000)
  return () => {
    clock.clearTimeout(timer)
    stopExplicitSeek()
    video.removeEventListener('pointerdown', interact)
    video.removeEventListener('keydown', interact)
    video.removeEventListener('seeking', seek)
  }
}
