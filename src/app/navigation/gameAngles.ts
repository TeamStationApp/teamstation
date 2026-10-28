/** Where the full-screen player was opened from on the videos page. */
export interface PlayerFrom {
  videoId: string
  sec: number
  /**
   * The wall time of that moment, by the picture's own mapping (its stream's
   * dates, the server's timeline, or its start), when it could say.
   */
  wallMs?: number | null
  /**
   * Where a highlight opened in it stops, in that video's seconds, and its
   * wall time by the same mapping as `wallMs`. Absent for the game opened
   * without a highlight.
   */
  untilSec?: number | null
  untilWallMs?: number | null
}

/** What a game's frame holds of the full-screen player. */
export interface GameAngles {
  angles?: string[]
  audio?: string
  zoom?: string
  at?: number
  from?: PlayerFrom
  /**
   * A highlight chosen somewhere else — a player's page — ending here
   * (seconds into `at`'s video): in the app, opened in the full-screen player
   * at once and stopped here; in a browser, played in the picture from `at`.
   * Never written to the address, and taken off the frame once it is done
   * with.
   */
  highlightUntil?: number
}

/**
 * A change to it, from the game screen. `null` clears a field, `undefined`
 * leaves it alone: without the difference there is no way to say "nothing is
 * zoomed any more".
 */
export interface AnglesChange {
  angles?: string[]
  audio?: string | null
  zoom?: string | null
  at?: number | null
  from?: PlayerFrom | null
  /**
   * Only ever `null`: the highlight is done with — opened in the app, or left to
   * the picture in a browser.
   */
  highlightUntil?: null
}

/** The game's frame with the change made. */
export function withAngles<T extends GameAngles>(
  frame: T,
  next: AnglesChange
): T {
  const kept = <V>(
    change: V | null | undefined,
    last: V | undefined
  ): V | undefined => (change === undefined ? last : (change ?? undefined))
  const { highlightUntil: _opened, ...rest } = frame
  const highlightUntil = kept(next.highlightUntil, frame.highlightUntil)
  return {
    ...(rest as T),
    ...(highlightUntil == null ? {} : { highlightUntil }),
    angles: next.angles ?? frame.angles,
    audio: kept(next.audio, frame.audio),
    zoom: kept(next.zoom, frame.zoom),
    at: kept(next.at, frame.at),
    from: kept(next.from, frame.from)
  }
}

/**
 * Whether the change is a page of its own in the history: opening the player
 * from the videos page is, so Back leaves it. Arranging the tiles and moving
 * through the game are not, or Back would mean "undo one drag".
 */
export function anglesOpenPage(next: AnglesChange): boolean {
  return next.from != null
}
