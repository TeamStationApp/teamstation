import { onExplicitSeek } from './explicitSeek'
import { LIVE_DELAY_SEC } from './liveDelay'
import type { VideoEventName } from './videoHandle'

/** A phone's player, as far as joining a live game needs it. */
export interface CushionedPlayer {
  currentTime: number
  /** The newest moment it could seek to, or null until it has said. */
  readonly liveEdge: number | null
  addEventListener: (type: VideoEventName, listener: () => void) => void
  removeEventListener: (type: VideoEventName, listener: () => void) => void
}

/**
 * How far from the cushion a player may start before it is moved: a start
 * already about that far behind the newest footage, where ExoPlayer's live
 * offset puts it, is left where it is.
 */
export const SLACK_SEC = 10

/**
 * How far short of the newest footage AVPlayer's seekable range ends: three
 * segments, the hold-back HLS asks of a live player. Only for the fallback,
 * when the playlist cannot be read.
 */
const HOLD_BACK_SEC = 12

/**
 * The live cushion, for a phone's player: `LIVE_DELAY_SEC` behind the newest
 * footage, as the browser plays (`liveStart.ts`).
 *
 * AVPlayer opens a live game three segments from its newest — twelve seconds
 * — and has nothing to play while the field's uplink catches its breath. The
 * publisher at a field sends late rather than dropping pictures, and a
 * Starlink dish that loses the sky for a few seconds leaves the playlist
 * standing still for fifteen or twenty: measured on the bench, a twelve-second
 * outage at the iPad held the iPhone's picture still for eleven to thirty
 * seconds at a time, while a browser a minute behind played straight through.
 *
 * So on the first play the newest footage is read off the live playlist
 * itself (`realEnd`: every segment it lists, its holes included), and the
 * player is moved to the cushion behind it, unless it is within `SLACK_SEC`
 * of it already. AVPlayer's seekable range stops short of the newest by a
 * hold-back of its own choosing, so it is only the fallback when the playlist
 * cannot be read. A seek of the viewer's own before that, a highlight or a
 * restored position, is left alone.
 */
export function joinLiveWithCushion(
  player: CushionedPlayer,
  realEnd: () => Promise<number | undefined> = async () => undefined
): () => void {
  let requested = false
  let asked = false
  let done = false
  const stopExplicitSeek = onExplicitSeek(player, () => {
    done = true
  })
  const moveTo = (end: number): void => {
    if (done) return
    done = true
    const target = Math.max(0, end - LIVE_DELAY_SEC)
    if (Math.abs(player.currentTime - target) <= SLACK_SEC) return
    player.currentTime = target
  }
  /**
   * Without the playlist: moved back by what it lacks, from where it is. The
   * seekable range's length is trusted for a distance only, never as a
   * position — a range that starts later than nought makes it short by that
   * much, and a seek to it sent a viewer nine minutes back.
   */
  const moveBack = (edge: number): void => {
    if (done) return
    done = true
    const behind = LIVE_DELAY_SEC - HOLD_BACK_SEC
    const ahead = edge - player.currentTime
    if (ahead >= behind - SLACK_SEC) return
    player.currentTime = Math.max(
      0,
      player.currentTime - (behind - Math.max(0, ahead))
    )
  }
  const join = (): void => {
    if (!requested || done || asked) return
    const edge = player.liveEdge
    if (edge == null || !Number.isFinite(edge) || edge <= 0) return
    asked = true
    realEnd().then(
      end => {
        if (end != null && Number.isFinite(end) && end > 0) moveTo(end)
        else moveBack(edge)
      },
      () => {
        moveBack(edge)
      }
    )
  }
  const play = (): void => {
    requested = true
    join()
  }
  player.addEventListener('play', play)
  player.addEventListener('timeupdate', join)
  return () => {
    done = true
    stopExplicitSeek()
    player.removeEventListener('play', play)
    player.removeEventListener('timeupdate', join)
  }
}
