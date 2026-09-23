import type { VideoHandle } from './videoHandle'
import type { Zone } from './zones'

/**
 * What a key press is allowed to do, shared by both `useKeyboardShortcuts`
 * files.
 *
 * In a third module because a native sibling cannot import from its own web
 * twin — Metro resolves the import back to the sibling itself.
 */
export interface KeyboardShortcuts {
  /**
   * Off while another player owns the keyboard.
   *
   * The multi-camera view is a state of the game screen rather than a route of
   * its own, so the single player stays mounted underneath it. Two
   * capture-phase listeners on `window` would then both answer one arrow key:
   * seeking the picture somebody is looking at, and a hidden one as well.
   */
  enabled?: boolean
  video: () => VideoHandle | null
  /** A press that does what a tap in that square would do. */
  act: (zone: Zone) => void
  /**
   * Where the arrows go, for a caller that moves more than one picture.
   * Left out, they move the one `video` returns.
   */
  seek?: (deltaSec: number) => void
  beginSlow: (zone: Zone) => void
  endSlow: () => void
  /** True while a crawl is running, so a key repeat does not start a second. */
  holding: () => boolean
}
