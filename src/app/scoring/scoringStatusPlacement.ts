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

/** How tall the band across the top is while the offline line sits in it. */
export const SCORING_OFFLINE_BAND = 28

/**
 * Where the offline line sits. On a phone: a filled band across the very
 * top, the line centred in its last `SCORING_OFFLINE_BAND` points under the
 * status bar; the field, its scoreboard and ☰ start under the band
 * (`BaseballScreen`'s `topBand`), so the line covers none of them and keeps
 * off the space above home plate, and the fill covers the strip the field
 * leaves. On the web the line keeps its place 8 from the top, between the
 * speaker and ☰ and above the board, and nothing moves: the web's field is
 * framed from the window's width, so a shorter canvas would only push home
 * plate under the deck.
 */
export function scoringOfflineFrame(
  native: boolean,
  insets: Insets,
  fill: string
): ViewStyle {
  if (!native)
    return {
      position: 'absolute',
      top: FIELD_EDGE_GAP,
      left: 0,
      right: 0,
      height: SCORING_OFFLINE_BAND,
      alignItems: 'center',
      justifyContent: 'center'
    }
  const top = Math.max(FIELD_EDGE_GAP, insets.top)
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: top,
    height: top + SCORING_OFFLINE_BAND,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: fill
  }
}
