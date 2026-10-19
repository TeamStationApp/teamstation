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
 * How far short of the newest footage AVPlayer's seekable range ends: three
 * segments, the hold-back HLS asks of a live player. The cushion is measured
 * from the newest footage, as the browser's is, so this much of it is
 * already there.
 */
export const HOLD_BACK_SEC = 12

/**
 * How much closer to the end of the seekable range than the cushion a player
 * may start before it is moved back: AVPlayer's own start, at that end, is
 * moved; a start already about a minute behind the newest footage, where
 * ExoPlayer's live offset puts it, is left where it is.
 */
const SLACK_SEC = 10

/**
 * The web's live cushion, for AVPlayer.
 *
 * AVPlayer opens a live game three segments from its newest — twelve seconds
 * — and has nothing to play while the field's uplink catches its breath. The
 * publisher at a field sends late rather than dropping pictures, and a
 * Starlink dish that loses the sky for a few seconds leaves the playlist
 * standing still for fifteen or twenty: measured on the bench, a twelve-second
 * outage at the iPad held the iPhone's picture still for eleven to thirty
 * seconds at a time, while a browser a minute behind played straight through.
 *
 * So on the first play, once the player has said where its seekable range
 * ends, it is moved back to a minute behind the newest footage — the same
 * cushion as the browser's (`liveStart.ts`). A seek of the viewer's own before that, a
 * highlight or a restored position, is left alone.
 */
export function joinLiveWithCushion(player: CushionedPlayer): () => void {
  let requested = false
  let done = false
  const stopExplicitSeek = onExplicitSeek(player, () => {
    done = true
  })
  const join = (): void => {
    if (!requested || done) return
    const edge = player.liveEdge
    if (edge == null || !Number.isFinite(edge) || edge <= 0) return
    done = true
    const behind = LIVE_DELAY_SEC - HOLD_BACK_SEC
    const ahead = edge - player.currentTime
    if (ahead >= behind - SLACK_SEC) return
    // Moved back by what it lacks, from where it is. The range's length is
    // trusted for a distance only, never as a position: a range that starts
    // later than nought makes it short by that much, and a seek to it sent
    // a viewer nine minutes back.
    player.currentTime = Math.max(
      0,
      player.currentTime - (behind - Math.max(0, ahead))
    )
  }
  const play = (): void => {
    requested = true
    join()
  }
  player.addEventListener('play', play)
  player.addEventListener('timeupdate', join)
  return () => {
    stopExplicitSeek()
    player.removeEventListener('play', play)
    player.removeEventListener('timeupdate', join)
  }
}
