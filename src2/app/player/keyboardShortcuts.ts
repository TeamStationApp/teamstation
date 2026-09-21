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
  video: () => VideoHandle | null
  /** A press that does what a tap in that square would do. */
  act: (zone: Zone) => void
  beginSlow: (zone: Zone) => void
  endSlow: () => void
  /** True while a crawl is running, so a key repeat does not start a second. */
  holding: () => boolean
}
