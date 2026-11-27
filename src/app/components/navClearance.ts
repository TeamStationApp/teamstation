import { NAV_HEIGHT, NAV_NATIVE_HEIGHT_ABOVE_INSET } from './navGeometry'

/** Distance between the window bottom and the bottom of the visible platter. */
export function floatingNavBottom(
  platform: string,
  marginPx: number,
  insetBottom: number,
  bannerPx = 0
): number {
  if (bannerPx > 0) return insetBottom + bannerPx
  // UIKit's host starts 49 points above the safe area. Its 62-point
  // material extends 13 points into that area on the reference phone.
  if (platform === 'ios')
    return Math.max(0, insetBottom + NAV_NATIVE_HEIGHT_ABOVE_INSET - NAV_HEIGHT)
  return marginPx + insetBottom
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
