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
   * How much this player may run ahead, for a caller driving several at once.
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
   * So a grid says what it may have, and the four together ask for less than
   * the single player does on its own.
   */
  buffer?: { seconds: number; megabytes: number }
}
