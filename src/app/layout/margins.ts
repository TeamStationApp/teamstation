import type { Breakpoint } from '../components/useBreakpoint'
import type { Theme } from '../theme/ThemeContext'

/**
 * The gap between the edge of the window and anything drawn in it, in rem.
 *
 * One number, asked for by everything that touches the edge: the content
 * column that the cards sit in, and the header that floats over it. They used
 * to each carry their own — the column a large space, the header a small one —
 * so the mark in the corner sat half as far in as the first card below it and
 * the two edges read as a mistake rather than as a margin.
 *
 * It widens a step above a phone, which is the column's own rule and the
 * spec's 24px, so the header follows the cards at every width.
 */
export function edgeMarginRem(theme: Theme, breakpoint: Breakpoint): number {
  return breakpoint === 'phone'
    ? theme.spaceLgRem * 0.8
    : theme.spaceLgRem * 1.2
}
