import {
  HAVE_CURRENT_DATA,
  HAVE_ENOUGH_DATA,
  HAVE_METADATA
} from './videoHandle'

/**
 * A native player's `readyState`, worked out from what the player reports,
 * in one place: the two platforms report in different orders, and every
 * rule about that order lives here rather than in each handler.
 *
 * ExoPlayer (Android) says when it starts opening an item, then reports
 * its first picture and that it holds enough, and only then the load; it
 * does so on every open, its own as well as the view's. AVPlayer (iOS)
 * reports the load first and its picture after, and says it is ready
 * before it has one.
 */
export interface Readiness {
  /** What a browser's `readyState` would be. */
  state: number
  /** The item has been reported loaded since it was last opened. */
  loaded: boolean
}

export type ReadinessEvent =
  /** The player has started opening an item. */
  | 'loadStart'
  /** The player has loaded the item. */
  | 'load'
  /** A picture is up. */
  | 'picture'
  /** The player has run short. */
  | 'bufferStart'
  /** The player says it has enough again. */
  | 'bufferEnd'
  /** The view asked for the source again, or a new one: nothing is known. */
  | 'reopen'

export interface ReadinessRules {
  /**
   * Android: a loaded player's buffer-ready report is enough to play,
   * picture reported or not, and a load start begins a new item.
   */
  readyOnBuffer: boolean
}

export const NOTHING_LOADED: Readiness = { state: 0, loaded: false }

export function nextReadiness(
  current: Readiness,
  event: ReadinessEvent,
  rules: ReadinessRules
): Readiness {
  switch (event) {
    case 'reopen':
      return NOTHING_LOADED
    case 'loadStart':
      // AVPlayer's load start says nothing about what it holds.
      return rules.readyOnBuffer ? NOTHING_LOADED : current
    case 'load':
      // The first load since the item was opened keeps a picture or a
      // buffer-ready reported ahead of it. On iOS a load reported again for
      // the same item is AVPlayer opening it once more, with nothing drawn.
      return {
        state: current.loaded
          ? HAVE_METADATA
          : Math.max(current.state, HAVE_METADATA),
        loaded: true
      }
    case 'picture':
      // What the multi-camera grid waits for before it believes a tile.
      return { ...current, state: Math.max(current.state, HAVE_ENOUGH_DATA) }
    case 'bufferStart':
      return { ...current, state: Math.min(current.state, HAVE_CURRENT_DATA) }
    case 'bufferEnd': {
      // A player still opening its source has no picture to play, except on
      // Android once it has loaded.
      const floor = rules.readyOnBuffer ? HAVE_METADATA : HAVE_CURRENT_DATA
      if (current.state < floor) return current
      return { ...current, state: HAVE_ENOUGH_DATA }
    }
  }
}
