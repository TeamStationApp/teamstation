import React from 'react'
import { type StyleProp, View, type ViewStyle } from 'react-native'
import Animated from 'react-native-reanimated'

import { edgeMarginRem } from '../layout/margins'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { NAV_CLEARANCE_REM } from './AppNav'
import { useHeaderSlot } from './headerSlot'
import { useBreakpoint } from './useBreakpoint'

export interface ScreenProps {
  children: React.ReactNode
  /** Off for a screen that manages its own scrolling, such as the player. */
  scroll?: boolean
  /**
   * Keep the margins and drop the reading-width cap.
   *
   * The cap exists so a line of text is not the width of a monitor. A video is
   * not a line of text: capping it letterboxes the one thing the screen is
   * for, with grey either side.
   */
  wide?: boolean
  contentStyle?: StyleProp<ViewStyle>
  /**
   * From `useHandoff`, when this screen hands something up to the header.
   *
   * An animated handler rather than a plain one: it runs on the animation
   * thread, so a list that scrolls does not re-render React to move a label.
   */
  onScroll?: Parameters<typeof Animated.ScrollView>[0]['onScroll']
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
  const {
    children,
    scroll = true,
    wide = false,
    contentStyle,
    onScroll
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const breakpoint = useBreakpoint()
  // The header is glass and overlays the content, so the content starts at the
  // top of the window and is pushed down by the height the header measured.
  // Anything else and there would be nothing behind the glass to blur.
  const { headerHeight } = useHeaderSlot()

  const inner = (
    <View
      style={[
        styles.column,
        breakpoint !== 'phone' && styles.columnWide,
        breakpoint === 'phone' && styles.clearOfNav,
        wide && styles.columnFull,
        contentStyle
      ]}
    >
      {children}
    </View>
  )

  if (!scroll) {
    return (
      <View style={[styles.fill, { paddingTop: headerHeight }]}>{inner}</View>
    )
  }

  return (
    <Animated.ScrollView
      style={styles.fill}
      onScroll={onScroll}
      scrollEventThrottle={16}
      contentContainerStyle={[
        styles.scrollContent,
        { paddingTop: headerHeight }
      ]}
    >
      {inner}
    </Animated.ScrollView>
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
  // The three destinations float over the content now rather than sitting in a
  // bar beneath it, so the last row of a list has to clear the capsule. Without
  // this the bottom team on the home screen reads through frosted glass.
  clearOfNav: {
    paddingBottom: theme.rem(NAV_CLEARANCE_REM)
  },
  column: {
    width: '100%',
    maxWidth: theme.rem(theme.maxContentWidthRem),
    // The margin the header uses too, so the mark in the corner lines up with
    // the first card underneath it.
    paddingHorizontal: theme.rem(edgeMarginRem(theme, 'phone')),
    paddingVertical: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceLgRem)
  },
  columnWide: {
    paddingHorizontal: theme.rem(edgeMarginRem(theme, 'tablet'))
  },
  columnFull: {
    maxWidth: '100%'
  }
}))
