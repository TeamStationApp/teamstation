import type { Theme } from './ThemeContext'

/** Keep text between a pill's two semicircular ends. */
export function pillPadding(height: number): number {
  return height / 2
}

/**
 * The compact pill's height, in rem: 20 points at the base size. Search's
 * kind pill, its location pills and Follow share it.
 */
export const COMPACT_PILL_REM = 1.25

/** The compact pill's label size, in rem: 12 points at the base size. */
export const COMPACT_PILL_LABEL_REM = 0.75

/** A compact pill's shell: its height, semicircular ends and padding. */
export function compactPill(theme: Theme): {
  height: number
  minHeight: number
  borderRadius: number
  paddingHorizontal: number
} {
  const height = theme.rem(COMPACT_PILL_REM)
  return {
    height,
    minHeight: height,
    borderRadius: height / 2,
    paddingHorizontal: pillPadding(height)
  }
}

/**
 * The lift a raised button and a raised pill share, so a pill reads as
 * something on the page rather than printed on it. Android draws it from
 * `elevation`, which needs the pill's opaque background.
 */
export function pillShadow(theme: Theme): {
  shadowColor: string
  shadowOpacity: number
  shadowRadius: number
  shadowOffset: { width: number; height: number }
  elevation: number
} {
  return {
    shadowColor: theme.buttonShadowColor,
    shadowOpacity: 1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3
  }
}
