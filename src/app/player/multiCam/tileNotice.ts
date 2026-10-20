import { lstrings } from '../../locales/strings'
import type { ParkReason } from './align'

/** What a tile with no picture to show is doing, as either grid says it. */
export interface TileNoticeState {
  /** This browser cannot play the video at all. */
  unsupported?: boolean
  /** The server has no playable copy. */
  unavailable: boolean
  /** The video has no start time, so it cannot be put on the game's clock. */
  unplaceable: boolean
  parked: ParkReason | null
  /** Held, or left out, until it catches up with the others. */
  waiting: boolean
}

/**
 * The words over a tile that is not showing the game: the first of these
 * that is true, and otherwise that it is still loading.
 */
export function tileNotice(state: TileNoticeState): string {
  if (state.unsupported === true) return lstrings.video_not_supported
  if (state.unavailable) return lstrings.game_video_unavailable
  if (state.unplaceable) return lstrings.angles_unplaceable
  if (state.parked === 'beforeStart') return lstrings.angles_not_recording_yet
  if (state.parked === 'afterEnd') return lstrings.angles_stopped
  if (state.parked === 'notYet') return lstrings.angles_tile_waiting_live
  if (state.waiting) return lstrings.angles_tile_catching_up
  return lstrings.angles_tile_loading
}
