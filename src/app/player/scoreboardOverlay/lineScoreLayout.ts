import type { BoardLine } from '../../../common/scoring/boardLineTypes'

/**
 * The box score's grid in its own units: what `LineScoreBox` draws at, then
 * scales into the rectangle the player gives it, as the board is scaled.
 *
 * Three rows (the inning numbers, then the visitors and the home side), the
 * team names fixed on the left and the runs, hits and errors fixed on the
 * right. The innings in between give way: as many as fit, the latest ones.
 */
export const LINE_ROW = 48
export const LINE_PAD = 4
/** The panel's edge, inside its size as both platforms draw a border. */
export const LINE_BORDER = 1
/** Three rows, the padding and the edge above and below: the box's height. */
export const LINE_BOX_HEIGHT = 3 * LINE_ROW + 2 * LINE_PAD + 2 * LINE_BORDER
export const LINE_NAME_WIDTH = 170
export const LINE_INNING_WIDTH = 36
export const LINE_TOTAL_WIDTH = 44
/** The box's side padding. */
export const LINE_SIDE = 8

/**
 * The innings a box is shaped and allowed to show: six. Past them the innings
 * move along, and it shows the latest six (`lineColumns`). Shaped for nine
 * or twelve, the box was drawn smaller for the same width, and its figures
 * were hard to read. The names take whatever the innings so far leave.
 */
export const LINE_INNINGS_SHAPED = 6
/** The box's width, in its own units: the names, six innings, the totals. */
export const LINE_BOX_WIDTH =
  2 * LINE_BORDER +
  2 * LINE_SIDE +
  LINE_NAME_WIDTH +
  3 * LINE_TOTAL_WIDTH +
  LINE_INNINGS_SHAPED * LINE_INNING_WIDTH

/** How tall a box `width` wide is drawn, in the same pixels. */
export function lineBoxHeight(width: number): number {
  return (width * LINE_BOX_HEIGHT) / LINE_BOX_WIDTH
}

/** How wide a box `height` tall is drawn, in the same pixels. */
export function lineBoxWidth(height: number): number {
  return (height * LINE_BOX_WIDTH) / LINE_BOX_HEIGHT
}

/** The latest inning either side has: 1 before anybody has batted. */
export function currentInning(line: BoardLine): number {
  return Math.max(1, line.away.innings.length, line.home.innings.length)
}

/**
 * The innings shown in a box `width` wide, in its own units: the latest that
 * fit after the names and the three totals, from the first to `current`, at
 * most `max` (`LINE_INNINGS_SHAPED` unless the box is drawn wider than six
 * innings' shape) and always at least one.
 */
export function lineColumns(
  width: number,
  current: number,
  max: number = LINE_INNINGS_SHAPED
): number[] {
  const room =
    width -
    2 * LINE_BORDER -
    2 * LINE_SIDE -
    LINE_NAME_WIDTH -
    3 * LINE_TOTAL_WIDTH
  // A box drawn at its own shape gives back its width a hair short.
  const fit = Math.min(
    max,
    Math.max(1, Math.floor(room / LINE_INNING_WIDTH + 1e-6))
  )
  const last = Math.max(1, current)
  const first = Math.max(1, last - fit + 1)
  return Array.from({ length: last - first + 1 }, (unused, i) => first + i)
}

/** A cell's text: blank for a half not started, `–` for a figure unknown. */
export function inningText(runs: number | null | undefined): string {
  return runs == null ? '' : String(runs)
}
export function totalText(value: number | null): string {
  return value == null ? '–' : String(value)
}
