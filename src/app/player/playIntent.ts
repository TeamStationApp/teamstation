import type { PlaybackSurface } from '../../common/observability/contract'
import type { WallMapping } from './wallMapping'

/**
 * What a caller tells `attachHls` about the player it hands over — shared by
 * the browser's `attachHls.ts` and the phone's `attachHls.native.ts`, which
 * cannot import from each other.
 */
export interface PlayIntent {
  /**
   * Whether the **viewer** wants this playing, as the caller understands it.
   *
   * Supplied only by a caller that pauses this element itself. The multi-camera
   * view does: it holds three tiles while a fourth stalls, and it pauses them
   * all while a tile that was not recording yet is parked. Without this the
   * pause below reads every one of those as the viewer pressing pause, and the
   * recovery this file exists to guarantee never fires again for that tile —
   * silently, and only on the stream that has already gone wrong once.
   *
   * A caller that never pauses the element from outside leaves this out, and
   * the element's own pause events remain the whole story, exactly as before.
   */
  wantsToPlay: () => boolean
  /**
   * How far ahead this player may load, for a caller driving several at once.
   *
   * Left out, hls.js is allowed what it likes, which is the right answer for
   * one player: it asks for 30 seconds, then grows the target as the line
   * allows until it is holding 60 MB. Four players doing that at once is
   * **240 MB, asked for at the same moment** — measured on a real take, the
   * grid pulled 178 MB in its first ten seconds for a game whose four streams
   * carry 11 Mbit/s between them. On a line that cannot serve that in ten
   * seconds the four spend the opening minutes starving each other.
   *
   * So a grid's tile is held to `aheadSec` (`AHEAD_SEC`) as a ceiling, which
   * it never grows past. Four live tiles on a line capped at 10.8 Mbit/s
   * started together and recovered together from a cut with that and nothing
   * more.
   */
  buffer?: {
    aheadSec: number
  }
  /**
   * Whether the server still lists this video as live, asked when its
   * playlist turns out to have been closed.
   *
   * Supplied for a video that was live when it was opened. The server closes
   * a live playlist when its publisher has been away for eight minutes, and a
   * player that reads the close stops for good; while the game still lists
   * the video as live, the web player waits for the playlist to open again
   * and rejoins it (`liveRejoin.ts`). Left out, an ended playlist ends the
   * video, as it always has.
   */
  isLive?: () => boolean | Promise<boolean>
  /**
   * The player is loading itself afresh (true) and has pictures again
   * (false). A pause between the two is the player's own — a reset element
   * is paused — not the viewer's, and an owner that reads its pauses as the
   * viewer's wish must not take that one as a wish to stop: the reload plays
   * on only if the viewer still wants it.
   */
  onRecovery?: (recovering: boolean) => void
  /**
   * Where this player shows, for its playback telemetry. Left out, it is
   * read from the rest: a buffered tile, a preview card, else the game page.
   */
  surface?: PlaybackSurface
  /** False for a highlight link or an explicitly restored playback position. */
  startAtLiveEdge?: boolean
  /**
   * A silent card preview rather than the viewer's own player: it joins and
   * recovers as a live viewer, but its stalls are not reported as theirs.
   */
  preview?: boolean
  /**
   * The player's own mapping onto the wall clock, each time it changes: from
   * the playlist's program date-times on hls.js, from Safari's start date on
   * its own player. Null once it is clear no dates are coming — a recording
   * without them, or a phone, whose players read none — so the owner falls
   * back to the server's wall timeline or the start time (`wallMapping.ts`).
   */
  onWallMapping?: (mapping: WallMapping | null) => void
  /**
   * The video's sample-entry tag (its row's `codecs`: `hvc1`, `avc1`), which
   * decides whether this browser's Media Source can take it. Left out, or
   * null, it is HEVC, as every video was before H.264 was recorded. A phone's
   * player plays both and reads nothing of it.
   */
  codecs?: string | null
  /** Nothing in this browser can play the video, and nothing was attached. */
  onUnsupported?: () => void
  /**
   * This player was left playing silent because its sound needs a tap here:
   * WebKit's own player, started silently to its first frame and wanted
   * playing by then, which iOS pauses if it is unmuted without one.
   */
  onSoundHeld?: () => void
  /**
   * Whether the owner wants this player silent now: the sound a silent first
   * play (`primeSilently`) puts back is this, not the element's at the start,
   * which can be from before the owner had set it.
   */
  muted?: () => boolean
  /**
   * Where the player starts, in its own seconds, for an owner that has
   * placed it already: a grid tile opened on a moment. hls.js then loads
   * from there, rather than from its own live position and moving it.
   */
  startSec?: number
}

/**
 * What a caller hands `attachHls`: the whole intent, for a player whose
 * playing it drives, or only the video's codec, for one that plays as a
 * plain player does (a finished game's card). Only a whole intent changes
 * how the player behaves.
 */
export type AttachIntent = PlayIntent | Pick<PlayIntent, 'codecs'>

/** The intent itself, when the caller gave one; undefined for a codec alone. */
export function playIntentOf(
  given: AttachIntent | undefined
): PlayIntent | undefined {
  return given != null && 'wantsToPlay' in given ? given : undefined
}
