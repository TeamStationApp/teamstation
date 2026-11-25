import type { GameSponsorReel } from '../../../common/sponsors/types'
import type { Rect } from '../controlGeometry'
import type { FrameLoop } from '../scoreboardOverlay/usePlayheadStep'

/** How far a reel may drift from the game's clock before it is put back. */
export const REEL_DRIFT_SEC = 0.3

export interface SponsorReelProps {
  /** The viewer's track of reels, on the game's wall clock. */
  reels: readonly GameSponsorReel[]
  /** The wall time of the game's picture showing now. */
  wallNow: () => number | null
  /** Where it is drawn, in its holder's coordinates; null for nowhere. */
  rect: Rect | null
  /** The player's mute: a muted player plays the reel muted too. */
  muted: boolean
  /** The game's pause: a paused game pauses the reel. */
  paused: boolean
  frames?: FrameLoop
  /**
   * Its layer: above the pictures (1 and 2 on the grids, up to 4 on the TV)
   * and below the controls. 3, the board's, unless said.
   */
  zIndex?: number
}
