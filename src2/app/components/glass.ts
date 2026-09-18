import type { ViewStyle } from 'react-native'

import type { Theme } from '../theme/types'

/**
 * Whether this browser can blur what is behind an element.
 *
 * Read once, at module load: it cannot change for the life of the page, and a
 * feature query per render of a header that is on every screen is waste.
 */
export const canBlur: boolean = (() => {
  const css = (globalThis as { CSS?: { supports?: (rule: string) => boolean } })
    .CSS
  if (css?.supports == null) return false
  return (
    css.supports('backdrop-filter: blur(1px)') ||
    css.supports('-webkit-backdrop-filter: blur(1px)')
  )
})()

/**
 * The glass: translucent, with the content blurred behind it.
 *
 * Where a browser cannot blur — or somebody has asked for less transparency —
 * the fill goes opaque rather than staying see-through. A translucent bar over
 * an unblurred photograph of a ball field is unreadable, which is worse than
 * a plain one.
 *
 * The tint is 55% rather than 72%: enough to read against, little enough that
 * the blur is obviously a blur. A heavier blur radius carries the difference —
 * the less the tint hides, the more the blur has to.
 *
 * `backdropFilter` is not in React Native's style types because no phone has
 * it; this app renders to the DOM, where it does. The cast is the seam, in one
 * place, rather than scattered through the components that want it.
 */
export function glassStyle(theme: Theme, opaque: boolean = false): ViewStyle {
  if (opaque || !canBlur) {
    return { backgroundColor: theme.glassFallbackColor }
  }
  return {
    backgroundColor: theme.glassBackgroundColor,
    backdropFilter: theme.glassBlur,
    WebkitBackdropFilter: theme.glassBlur
  } as unknown as ViewStyle
}

/** A web style React Native has no name for. One cast, kept in one place. */
export function webStyle(style: Record<string, unknown>): ViewStyle {
  return style as unknown as ViewStyle
}
