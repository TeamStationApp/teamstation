/**
 * The TeamStation mark, as path data: a rounded square standing on its corner,
 * with two arcs bowing in from its sides.
 *
 * Carved from the designer's file (`teamStationMark.svg` beside this module's
 * assets): its cream tile and drop shadow were the designer's background, not
 * the mark, so only the three strokes and their gradient are here. The mark is
 * strokes, not fills, so whatever is behind it shows through its middle.
 *
 * Both renderers and the icon script read this file, so the shape is written
 * down once.
 */
export const MARK_VIEW_BOX = '24 24 464 464'
export const MARK_STROKE_WIDTH = 50

/** The square, then the left arc, then the right. */
export const MARK_PATHS: string[] = [
  'M 224.89 66.49 A 44 44 0 0 1 287.11 66.49 L 445.51 224.89 A 44 44 0 0 1 445.51 287.11 L 287.11 445.51 A 44 44 0 0 1 224.89 445.51 L 66.49 287.11 A 44 44 0 0 1 66.49 224.89 Z',
  'M 146 146 Q 236 256 146 366',
  'M 366 146 Q 276 256 366 366'
]

/**
 * The gradient runs corner to corner, top left to bottom right, in the mark's
 * own coordinates. It holds the start colour to 40% and the end colour from
 * 60%, so the change happens across the middle.
 */
export const MARK_GRADIENT = { x1: 80, y1: 80, x2: 432, y2: 432 }
export const MARK_GRADIENT_STOPS: [number, number] = [0.4, 0.6]
