import React, { createContext, useContext, useMemo } from 'react'

import { gsDark } from './gsDark'
import type { Theme } from './types'

/**
 * The theme a screen reads, in the shape edge-react-gui uses: a provider at
 * the root, a `useTheme` hook, and `cacheStyles` so a stylesheet is built once
 * per theme rather than on every render.
 *
 * No screen imports `gsDark` directly. Swapping themes later is a change here.
 */
const ThemeContext = createContext<Theme>(gsDark)

export interface ThemeProviderProps {
  theme?: Theme
  children: React.ReactNode
}

export function ThemeProvider(props: ThemeProviderProps): React.ReactElement {
  const { theme = gsDark, children } = props
  const value = useMemo(() => theme, [theme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

/**
 * Builds a stylesheet from a theme, once per theme.
 *
 *   const getStyles = cacheStyles((theme: Theme) => ({ … }))
 *   const styles = getStyles(useTheme())
 *
 * A `WeakMap` means a theme that falls out of use takes its styles with it.
 */
export function cacheStyles<T extends object>(
  build: (theme: Theme) => T
): (theme: Theme) => T {
  const cache = new WeakMap<Theme, T>()
  return (theme: Theme): T => {
    const cached = cache.get(theme)
    if (cached != null) return cached
    const styles = build(theme)
    cache.set(theme, styles)
    return styles
  }
}
