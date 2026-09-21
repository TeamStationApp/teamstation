import React from 'react'
import { type StyleProp, View, type ViewStyle } from 'react-native'
import Animated from 'react-native-reanimated'

import { edgeMarginRem } from '../layout/margins'
import { useInsets } from '../platform/safeArea'
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
  /**
   * Centre a short screen's content in the window rather than starting it at
   * the top: a sign-in card, an invitation.
   *
   * On the container rather than as `flex: 1` on the column. A column with
   * `flex: 1` is exactly the height of the scroll view, so its content size
   * can never exceed its frame and the screen can never scroll — which is a
   * problem the moment a keyboard covers the lower half of the card, because
   * what is behind it is then unreachable. Centred from here the column keeps
   * its natural height and the screen scrolls as soon as there is more content
   * than room.
   *
   * Verified on Android, where the window is resized under the keyboard.
   * **Unverified on iOS, and the earlier note here claiming it did not work
   * there should not have been written.** Every iOS run behind that claim was
   * driven through Maestro on the iPhone 17 Pro simulator, whose driver
   * delivers drags as taps (see `MOBILE.md`) — an instrument that cannot drag
   * cannot test dragging. Retry on the iPad simulator, where drags work, or
   * with a finger.
   */
  centreContent?: boolean
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
    centreContent = false,
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
  // The capsule floats above the home indicator, so the clearance under the
  // last row has to cover both.
  const insets = useInsets()

  // Held sideways, a phone's insets are at the sides: the camera housing on
  // one edge and a rounded corner on the other. The margin takes whichever is
  // wider — the design's, or the hardware's — so a line of text never starts
  // underneath the island.
  const margin = theme.rem(edgeMarginRem(theme, breakpoint))

  const inner = (
    <View
      style={[
        styles.column,
        breakpoint !== 'phone' && styles.columnWide,
        breakpoint === 'phone' && styles.clearOfNav,
        {
          paddingLeft: Math.max(margin, insets.left),
          paddingRight: Math.max(margin, insets.right)
        },
        breakpoint === 'phone' && {
          paddingBottom: theme.rem(NAV_CLEARANCE_REM) + insets.bottom
        },
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
      // Without this the first tap on a button while a field has focus only
      // dismisses the keyboard and the button is never pressed — so `Sign in`,
      // `Join` and every `Save` on the manage page take two taps on a phone
      // and one in a browser.
      keyboardShouldPersistTaps="handled"
      // Dragging the page puts the keyboard away. Android has a Back key that
      // does this and iOS has nothing at all, so without it a screen whose
      // content is shorter than the window — the sign-in card is the one that
      // matters — can raise a keyboard that there is then no way to lower:
      // there is nothing to scroll and no blank area to tap, and the control
      // you need is behind it. `handled` above is deliberately kept, so a tap
      // still reaches a button first time; this covers everything else.
      keyboardDismissMode="on-drag"
      // And the keyboard insets the content rather than covering it. iOS does
      // that for a scroll view when asked and not otherwise; Android resizes
      // the window instead, which `adjustResize` in the manifest already asks
      // for; and a browser has no keyboard of its own to make room for. One
      // property, three answers, and only one of them needs saying here.
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[
        styles.scrollContent,
        centreContent && styles.centreContent,
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
  centreContent: {
    justifyContent: 'center'
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
