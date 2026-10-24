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
