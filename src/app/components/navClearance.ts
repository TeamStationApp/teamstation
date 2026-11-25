import { NAV_HEIGHT, NAV_NATIVE_HEIGHT_ABOVE_INSET } from './navGeometry'

/** Where the floating bar's platter rests with no banner, from the window bottom. */
function restingNavBottom(
  platform: string,
  marginPx: number,
  insetBottom: number
): number {
  // UIKit's host starts 49 points above the safe area. Its 62-point
  // material extends 13 points into that area on the reference phone.
  if (platform === 'ios')
    return Math.max(0, insetBottom + NAV_NATIVE_HEIGHT_ABOVE_INSET - NAV_HEIGHT)
  return marginPx + insetBottom
}

/**
 * Where the offline banner's bottom edge sits under the floating bar.
 *
 * On iOS the resting material reaches into the safe area, so the banner
 * starts at that edge: the bar then rides on the banner's top from its first
 * frame, with no jump and no overlap. Elsewhere it sits on the inset, inside
 * the bar's margin.
 */
export function offlineBannerBottom(
  platform: string,
  insetBottom: number
): number {
  return platform === 'ios'
    ? Math.min(insetBottom, restingNavBottom(platform, 0, insetBottom))
    : insetBottom
}

/**
 * Distance between the window bottom and the bottom of the visible platter.
 *
 * Continuous in the banner's presented height: the platter keeps its resting
 * place until the banner reaches it, then moves with the banner's top.
 */
export function floatingNavBottom(
  platform: string,
  marginPx: number,
  insetBottom: number,
  bannerPx = 0
): number {
  return Math.max(
    restingNavBottom(platform, marginPx, insetBottom),
    offlineBannerBottom(platform, insetBottom) + bannerPx
  )
}

/** Scrolling content preserves its outer margin above a banner on Android and web. */
export function navContentBottom(
  platform: string,
  marginPx: number,
  insetBottom: number,
  bannerPx = 0
): number {
  return platform === 'ios'
    ? floatingNavBottom(platform, marginPx, insetBottom, bannerPx)
    : insetBottom + marginPx + bannerPx
}
