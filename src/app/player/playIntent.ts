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
   * seconds the four spend the opening minutes starving each other, which is
   * how a camera stops drawing and takes the sound down with it.
   *
   * So a grid starts each player at `aheadSec` and moves the limit itself
   * while they play, through the control handed to `onControl`: raised as the
   * slowest of them fills, lowered on the ones that have got ahead.
   */
  buffer?: {
    aheadSec: number
    /** Called with the control once the player exists, and null when it goes. */
    onControl?: (control: BufferControl | null) => void
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
  /** False for a highlight link or an explicitly restored playback position. */
  startAtLiveEdge?: boolean
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
}

/** Moves a running player's limit on how far ahead it loads. */
export interface BufferControl {
  setAheadSec: (seconds: number) => void
}
