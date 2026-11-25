// Where a game's sponsor reels are on its wall clock: which reel plays at a
// moment, from how far into it, and how loud the game is around it. Pure,
// so every player (the card, the grids, the phones and the TV) answers the
// same for the same moment, live or recorded, and a join or a seek mid-reel
// starts it at the right place with the game already quiet.
import type { LogoPlacement } from '../../../common/nodeSettings'
import type {
  GameSponsorReel,
  GameSponsors
} from '../../../common/sponsors/types'

/** How long the game takes to fade under a reel, and back. */
export const REEL_FADE_MS = 1000

/** How loud the game is while a reel plays. */
export const REEL_GAME_VOLUME = 0.2

/** A reel playing at a moment, and how far into it the moment is. */
export interface ReelNow {
  reel: GameSponsorReel
  offsetMs: number
}

/**
 * The reel playing at `wallMs`: one is on over `[startMs, startMs +
 * durationMs)`. Where two overlap, the one that started first plays out.
 */
export function reelAt(
  reels: readonly GameSponsorReel[],
  wallMs: number | null
): ReelNow | null {
  if (wallMs == null || !Number.isFinite(wallMs)) return null
  let found: GameSponsorReel | null = null
  for (const reel of reels) {
    if (wallMs < reel.startMs || wallMs >= reel.startMs + reel.durationMs)
      continue
    if (found == null || reel.startMs < found.startMs) found = reel
  }
  return found == null
    ? null
    : { reel: found, offsetMs: wallMs - found.startMs }
}

/**
 * How loud the game is at `wallMs`, from 1 to `REEL_GAME_VOLUME`: down
 * over the second before each reel, held through it, and up over the
 * second after. Between reels closer than that it stays down.
 */
export function gameVolumeAt(
  reels: readonly GameSponsorReel[],
  wallMs: number | null
): number {
  if (wallMs == null || !Number.isFinite(wallMs)) return 1
  let volume = 1
  for (const reel of reels) {
    const end = reel.startMs + reel.durationMs
    let here = 1
    if (wallMs >= reel.startMs - REEL_FADE_MS && wallMs < reel.startMs)
      here =
        1 -
        ((1 - REEL_GAME_VOLUME) * (wallMs - (reel.startMs - REEL_FADE_MS))) /
          REEL_FADE_MS
    else if (wallMs >= reel.startMs && wallMs < end) here = REEL_GAME_VOLUME
    else if (wallMs >= end && wallMs < end + REEL_FADE_MS)
      here =
        REEL_GAME_VOLUME +
        ((1 - REEL_GAME_VOLUME) * (wallMs - end)) / REEL_FADE_MS
    volume = Math.min(volume, here)
  }
  return volume
}

/** Which of the node's logo placements a player uses. */
export type LogoPlacementKind = 'single' | 'grid' | 'tv' | 'portrait'

export function logoPlacementFor(
  overlay: GameSponsors['overlay'],
  kind: LogoPlacementKind
): LogoPlacement {
  return overlay.logo[kind]
}

/** A reel's own shape, as width over height; 16:9 when it does not say. */
export function reelAspect(reel: GameSponsorReel | null | undefined): number {
  return reel != null && reel.width > 0 && reel.height > 0
    ? reel.width / reel.height
    : 16 / 9
}
