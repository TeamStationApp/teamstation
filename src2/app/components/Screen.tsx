import React from 'react'
import { ScrollView, type StyleProp, View, type ViewStyle } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useBreakpoint } from './useBreakpoint'

export interface ScreenProps {
  children: React.ReactNode
  /** Off for a screen that manages its own scrolling, such as the player. */
  scroll?: boolean
  contentStyle?: StyleProp<ViewStyle>
}

/**
 * The content column.
 *
 * Every design is drawn at phone width, where the answer is simply "the whole
 * window, with a margin". On a desktop that same layout gives a line of text
 * the full width of a monitor, which nobody can read, and a list of teams each
 * a thousand pixels wide with a chevron marooned at the far end.
 *
 * So the column stops at `maxContentWidthRem` and centres. The screens keep
 * their single-column stacking and simply stop growing; where a grid makes
 * sense — teams, videos — the screen asks `useBreakpoint` and lays out in
 * columns itself. Margins widen a step on a tablet, per the spec's 24px.
 */
export function Screen(props: ScreenProps): React.ReactElement {
  const { children, scroll = true, contentStyle } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const breakpoint = useBreakpoint()

  const inner = (
    <View
      style={[
        styles.column,
        breakpoint !== 'phone' && styles.columnWide,
        contentStyle
      ]}
    >
      {children}
    </View>
  )

  if (!scroll) return <View style={styles.fill}>{inner}</View>

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={styles.scrollContent}
    >
      {inner}
    </ScrollView>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  fill: {
    flex: 1,
    backgroundColor: theme.backgroundColor
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center'
  },
  column: {
    width: '100%',
    maxWidth: theme.rem(theme.maxContentWidthRem),
    paddingHorizontal: theme.rem(theme.spaceLgRem * 0.8),
    paddingVertical: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceLgRem)
  },
  columnWide: {
    paddingHorizontal: theme.rem(theme.spaceLgRem * 1.2)
  }
}))
