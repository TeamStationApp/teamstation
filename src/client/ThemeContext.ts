import { cacheStyles, makeThemeContext } from 'react-native-patina'

import { gsDark } from './themes/gsDark'
import type { Theme } from './types'

export type { Theme }
export { cacheStyles }

/**
 * Utility for declaring `withTheme` components.
 */
export interface ThemeProps {
  theme: Theme
}

// Provide the theme context methods:
const themeContext = makeThemeContext(gsDark)
export const {
  ThemeProvider,
  useTheme,
  withTheme,
  changeTheme,
  getTheme,
  watchTheme
} = themeContext
