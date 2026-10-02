import { cacheStyles, makeThemeContext } from 'react-native-patina'

import { tsBallpark } from './tsBallpark'
import type { Theme } from './types'

export type { Theme }
export { cacheStyles }

/**
 * The theme a screen reads.
 *
 * This was a hand-written copy of patina's shape — a context, a `useTheme`, a
 * `cacheStyles` built on a WeakMap. It is the real thing now, which is what
 * the rest of Paul's work uses, so there is one set of behaviours to know
 * rather than two that merely resemble each other.
 *
 *   const getStyles = cacheStyles((theme: Theme) => ({ … }))
 *   const styles = getStyles(useTheme())
 *
 * `tsBallpark` is the default: the light Organic Ballpark Classic theme the
 * designs are drawn in. `tsDark` is still here and still complete, because a
 * theme framework carrying one theme is a framework nobody has tested — and
 * the second theme is what proves no screen has quietly spelled out a colour.
 *
 * Switch with `changeTheme(tsDark)`; every screen follows without re-rendering
 * from the root, because patina notifies rather than re-parents.
 */
export interface ThemeProps {
  theme: Theme
}

const themeContext = makeThemeContext<Theme>(tsBallpark)

export const {
  ThemeProvider,
  useTheme,
  withTheme,
  changeTheme,
  getTheme,
  watchTheme
} = themeContext
