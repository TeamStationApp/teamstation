import type { ViewStyle } from 'react-native'

import { FIELD_EDGE_GAP } from '../field/fieldSafeArea'
import type { Insets } from '../platform/insets'
import {
  CONTROL_DECK_HEIGHT,
  CONTROL_GAP,
  CONTROL_HEIGHT
} from './scoringControlStyle'

/** The widest the status pill runs, so a long message wraps into a column. */
export const SCORING_STATUS_MAX_WIDTH = 480

/**
 * Where the scoring screen's status line sits: what the save is doing, that
 * the phone is offline, or why a game's queue stopped.
 *
 * On a phone it sits on the grass just above the bottom deck, clear of the
 * band right over the deck (the walk-up row, the at-bat's Done pill and the
 * dictation button, each one control high), so it never covers the
 * scoreboard or ☰ under the status bar, however long it stays up and however
 * many lines it takes. The web keeps it where it has always been, centred 8
 * from the top, where only a save's passing status ever shows.
 */
export function scoringStatusFrame(native: boolean, insets: Insets): ViewStyle {
  if (!native)
    return {
      position: 'absolute',
      top: FIELD_EDGE_GAP,
      left: 0,
      right: 0,
      alignItems: 'center'
    }
  return {
    position: 'absolute',
    bottom:
      // The deck's own edge, as `fieldSafePadding` leaves it…
      insets.bottom +
      FIELD_EDGE_GAP +
      CONTROL_DECK_HEIGHT +
      // …then the band of single controls that can stand on it.
      CONTROL_GAP +
      CONTROL_HEIGHT +
      CONTROL_GAP,
    left: Math.max(FIELD_EDGE_GAP, insets.left),
    right: Math.max(FIELD_EDGE_GAP, insets.right),
    alignItems: 'center'
  }
}
