/**
 * Where the floating capsule sits, and how much a screen leaves beneath its
 * last row.
 *
 * On iOS the home-indicator inset is already the gap under the capsule, so
 * the capsule's bottom edge is that inset. Android's navigation inset does
 * not leave the same empty band, and a browser has no inset at all, so both
 * keep the margin the capsule was designed with.
 */

/** Pixels from the window's bottom edge to the capsule's bottom edge. */
export function floatingNavBottom(
  platform: string,
  marginPx: number,
  insetBottom: number
): number {
  return platform === 'ios' ? insetBottom : marginPx + insetBottom
}

/**
 * The clearance under the last row, before the hardware inset is added back.
 *
 * iOS drops the designed margin, because that margin and the inset were the
 * same gap counted twice.
 */
export function navClearanceAboveInset(
  platform: string,
  clearancePx: number,
  marginPx: number
): number {
  return platform === 'ios' ? clearancePx - marginPx : clearancePx
}
