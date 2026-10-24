import { TABLET_MAX } from '../components/useBreakpoint'

/** How wide Tess's chat column is beside the app on a wide screen. */
export const TESS_COLUMN_WIDTH = 400

/**
 * Whether a window this wide shows Tess beside the app rather than over it:
 * wider than a portrait tablet, so the pane keeps at least a tablet's width.
 */
export function tessIsWide(windowWidth: number): boolean {
  return windowWidth > TABLET_MAX
}
