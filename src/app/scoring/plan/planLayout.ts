import { Platform } from 'react-native'

/**
 * The game plan sheet's sizes. A cell holds at most two characters of a
 * monospace font, whose every glyph is 0.6 em wide: 19.2 points at 16, plus
 * 8 points of padding, rounded up, is an inning column.
 */
export const PLAN_CELL_FONT_SIZE = 16
export const PLAN_CELL_FONT_FAMILY =
  Platform.OS === 'ios'
    ? 'ui-monospace'
    : Platform.OS === 'web'
      ? 'ui-monospace, Menlo, Consolas, monospace'
      : 'monospace'
export const PLAN_CELL_FONT = {
  fontFamily: PLAN_CELL_FONT_FAMILY,
  fontSize: PLAN_CELL_FONT_SIZE
} as const
export const PLAN_COLUMN_WIDTH = 28
/** A row of the sheet: a dense table's cells are touch targets too. */
export const PLAN_ROW_HEIGHT = 44
/** The inning numbers above the columns. */
export const PLAN_HEADER_HEIGHT = 32
/** The batting slot's number, left of the player. */
export const PLAN_SLOT_WIDTH = 24
/** The player, "#27 Ruth", wide enough for six innings beside it on a phone. */
export const PLAN_PLAYER_WIDTH = 136
/** The field picker's card. */
export const PLAN_PICKER_WIDTH = 320
export const PLAN_PICKER_HEIGHT = 262
/** Space between the picker and the row it edits. */
const PICKER_GAP = 4

/**
 * Where the field picker's top goes, in the coordinates of the area it is
 * drawn over: under the row it edits when it fits there, else over it, so
 * the cell being set stays in sight; and where neither fits, against the
 * edge with more room, never past the area.
 */
export function planPickerTop({
  rowTop,
  rowBottom,
  height,
  areaTop,
  areaBottom
}: {
  rowTop: number
  rowBottom: number
  height: number
  areaTop: number
  areaBottom: number
}): number {
  if (rowBottom + PICKER_GAP + height <= areaBottom)
    return rowBottom + PICKER_GAP
  if (rowTop - PICKER_GAP - height >= areaTop)
    return rowTop - PICKER_GAP - height
  return areaBottom - rowBottom >= rowTop - areaTop
    ? Math.max(areaTop, areaBottom - height)
    : areaTop
}
