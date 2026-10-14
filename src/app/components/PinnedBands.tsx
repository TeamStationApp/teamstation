import React from 'react'
import { type LayoutChangeEvent, View } from 'react-native'
import Animated from 'react-native-reanimated'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useContentInset } from './contentInset'
import { useHeaderSlot } from './headerSlot'
import type { PinnedHead } from './pinnedHead'

/**
 * The parts of a screen whose head is pinned by `usePinnedHead`: the band
 * holding the card, the band holding the pills under it, the selected tab's
 * content, and the space after it. A screen places them in this order in its
 * `Screen` and the hook does the rest.
 */

/** The band holding the card that scrolls away under the header. */
export function CardBand(props: {
  part: PinnedHead['cardBand']
  children: React.ReactNode
}): React.ReactElement {
  const { part, children } = props
  const styles = getStyles(useTheme())
  const { headerHeight } = useHeaderSlot()
  return (
    <Band
      ref={part.ref}
      onLayout={part.handleLayout}
      style={[styles.band, styles.cardBand, part.style]}
    >
      {/*
        The page behind the glass header, which the card band carries up
        with it: a held card has rows scrolled up under it, and they would
        otherwise show through the glass above the card.
      */}
      <View
        pointerEvents="none"
        // Placed by its top rather than `bottom: '100%'`, which Yoga
        // measures against the band's padded content box, not its edge.
        style={[styles.backdrop, { top: -headerHeight, height: headerHeight }]}
      />
      {children}
    </Band>
  )
}

/** The band holding the pills, which pins under the header. */
export function PillBand(props: {
  part: PinnedHead['pillBand']
  children: React.ReactNode
}): React.ReactElement {
  const { part, children } = props
  const styles = getStyles(useTheme())
  return (
    <Band
      ref={part.ref}
      onLayout={part.handleLayout}
      style={[styles.band, styles.pillBand, part.style]}
    >
      {/*
        A sliver of the page above the pills, under the header's lower edge.
        iOS's glass blurs less at its very edge, and a row passing under it
        showed sharp there, just above the pinned pills.
      */}
      <View
        pointerEvents="none"
        style={[styles.backdrop, { top: -GLASS_EDGE, height: GLASS_EDGE }]}
      />
      {children}
    </Band>
  )
}

/**
 * One view for whichever tab is showing. Give it `key={tab}`, so each tab is
 * a new view: the anchor measures it, and a tab that is new to the page has
 * to be laid out before it can be.
 */
export function PinnedContent(props: {
  part: PinnedHead['content']
  testID?: string
  children: React.ReactNode
}): React.ReactElement {
  const { part, testID, children } = props
  const styles = getStyles(useTheme())
  return (
    <View
      testID={testID}
      ref={part.ref}
      onLayout={part.handleLayout}
      style={styles.tabContent}
    >
      {children}
    </View>
  )
}

/** Room for the tab to start under the pills however short it is. */
export function PinnedSpacer(props: {
  part: PinnedHead['spacer']
}): React.ReactElement {
  const { part } = props
  const styles = getStyles(useTheme())
  return (
    <View
      ref={part.ref}
      onLayout={part.handleLayout}
      testID="pinnedSpacer"
      style={[styles.spacer, part.style]}
    />
  )
}

/** How much of the header's lower edge the pill band paints behind. */
const GLASS_EDGE = 4

/**
 * A strip of the page as wide as the screen: through the column's margins, and
 * painted, so what scrolls under it does not show at its sides.
 */
function Band(props: {
  children: React.ReactNode
  ref?: React.Ref<React.ComponentRef<typeof View>>
  onLayout?: (event: LayoutChangeEvent) => void
  style: React.ComponentProps<typeof Animated.View>['style']
}): React.ReactElement {
  const { children, ref, onLayout, style } = props
  const inset = useContentInset()
  return (
    <Animated.View
      ref={ref}
      onLayout={onLayout}
      style={[
        {
          marginLeft: -inset.left,
          marginRight: -inset.right,
          paddingLeft: inset.left,
          paddingRight: inset.right
        },
        style
      ]}
    >
      {children}
    </Animated.View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  band: {
    backgroundColor: theme.backgroundColor,
    // Android paints by elevation and ignores `zIndex` where the two
    // disagree, and every row is a card with an elevation of its own. The
    // shadow is not wanted: the band is the page, not something on it.
    shadowColor: 'transparent'
  },
  cardBand: {
    zIndex: 2,
    elevation: 8,
    // Over the column's top margin and the gap down to the pills, so a held
    // card hides what has scrolled up under it.
    marginTop: -theme.rem(theme.spaceLgRem),
    paddingTop: theme.rem(theme.spaceLgRem),
    marginBottom: -theme.rem(theme.spaceLgRem),
    paddingBottom: theme.rem(theme.spaceLgRem)
  },
  pillBand: {
    zIndex: 3,
    elevation: 9,
    // Takes back the column's gap, so the content starts at the band's lower
    // edge: the pills' own target room, the same below them as above.
    marginBottom: -theme.rem(theme.spaceLgRem)
  },
  backdrop: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: theme.backgroundColor
  },
  tabContent: {
    gap: theme.rem(theme.spaceLgRem)
  },
  spacer: {
    // Takes back the column's gap before it, so a tab with no room after it
    // ends where it always did.
    marginTop: -theme.rem(theme.spaceLgRem)
  }
}))
