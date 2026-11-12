import type { ViewStyle } from 'react-native'

import type { Insets } from '../platform/insets'

/** The space the web leaves between its controls and the window's edge. */
export const FIELD_EDGE_GAP = 8
/**
 * The field's padding on a phone. Each edge keeps the web's 8 point gap
 * *beyond* whatever the hardware takes, never inside it: `max(8, inset)`, as
 * the web writes it, put the bottom deck flush on the home indicator's safe
 * line, with no gap left at all.
 */
export function fieldSafePadding(insets: Insets): ViewStyle {
  return {
    paddingTop: Math.max(FIELD_EDGE_GAP, insets.top),
    paddingBottom: insets.bottom + FIELD_EDGE_GAP,
    paddingLeft: Math.max(FIELD_EDGE_GAP, insets.left),
    paddingRight: Math.max(FIELD_EDGE_GAP, insets.right)
  }
}

/**
 * The safe area's padding with `band` more at the top (less, for a negative
 * band: the lift into the top inset): added on a phone, whose inset is a
 * number, and through `calc()` on the web, whose inset is the browser's
 * `env()`. The one rule for a lifted or banded top, on both field screens.
 */
export function bandedSafe(safe: ViewStyle, band: number): ViewStyle {
  if (band === 0) return safe
  const top = safe.paddingTop
  return {
    ...safe,
    paddingTop:
      typeof top === 'number'
        ? top + band
        : top == null
          ? `${Math.max(0, band)}px`
          : `calc(${String(top)} ${band < 0 ? '-' : '+'} ${Math.abs(band)}px)`
  }
}

/**
 * The field's padding for insets in points, `lift` (`topLift`) less at the
 * top: what `bandedSafe` gives the scoring screen's header row, for the
 * replay, which has its insets as numbers. With the lift `topLift` gives it
 * is `max(FIELD_EDGE_GAP, inset − lift)`, never above the edge gap.
 */
export function liftedSafePadding(insets: Insets, lift: number): ViewStyle {
  return bandedSafe(fieldSafePadding(insets), -lift)
}

/** Where the ☰ button's bottom and right edges sit, from the screen's top and right. */
export interface MenuButtonEdges {
  bottom: number
  right: number
}
/** The web's ☰: 48 square, 8 in from the top and right of the window. */
export const WEB_MENU_BUTTON: MenuButtonEdges = { bottom: 56, right: 8 }
/**
 * The ☰ button's edges, from the layout of the header row it ends and the
 * width of the screen that row sits in.
 */
export function menuButtonEdges(
  header: { x: number; y: number; width: number; height: number },
  screenWidth: number
): MenuButtonEdges {
  return {
    bottom: header.y + header.height,
    right: screenWidth - (header.x + header.width)
  }
}
/**
 * The scoring menu opens below ☰, as the web's does (top 64, right 12), so ☰
 * stays uncovered and a second tap on it lands on the dismiss layer.
 */
export function scoringMenuFrame(button: MenuButtonEdges): {
  top: number
  right: number
} {
  return { top: button.bottom + 8, right: button.right + 4 }
}
/** The instruction toast starts no higher than this: the web's 62, below ☰. */
export function toastTopBelow(button: MenuButtonEdges): number {
  return button.bottom + 6
}

/**
 * The instruction toast laid over the header row at a phone's height: clear
 * of ☰ on the right and, with the speaker there, of it on the left.
 */
export function compactToastBounds<T extends { x: number; width: number }>(
  header: T,
  speaker: boolean
): T {
  return speaker
    ? { ...header, x: header.x + 56, width: Math.max(100, header.width - 112) }
    : { ...header, width: Math.max(100, header.width - 56) }
}

/** Half the top buttons' 48 pt: how far the controls and the scene rise. */
export const TOP_LIFT = 24
/**
 * How far they rise for a top inset on a platform (`Platform.OS`): up to
 * TOP_LIFT, never above the 8 pt edge gap. Android never lifts: its status
 * bar's clock and icons sit where the lifted buttons would.
 */
export function topLift(insetTop: number, os: string): number {
  if (os === 'android') return 0
  return Math.min(TOP_LIFT, Math.max(0, insetTop - FIELD_EDGE_GAP))
}

/** The replay's round rewind and pause buttons, across. */
export const FLOATING_SIZE = 56
/** How far the rewind and pause buttons sit from their side, and from the bottom with no inset. */
export const FLOATING_MARGIN = 16
/** The least a floating button keeps from the window's bottom edge. */
export const FLOATING_FLOOR = 4
/**
 * The floating buttons' distance from the window's bottom for a bottom inset:
 * centred on the safe area's top edge, half inside it, but never closer than
 * FLOATING_FLOOR to the window's edge; with no inset, FLOATING_MARGIN.
 */
export function floatingBottom(insetBottom: number): number {
  return insetBottom === 0
    ? FLOATING_MARGIN
    : Math.max(FLOATING_FLOOR, insetBottom - FLOATING_SIZE / 2)
}
