import React from 'react'
import { type LayoutChangeEvent, useWindowDimensions, View } from 'react-native'
import Animated from 'react-native-reanimated'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useContentInset } from './contentInset'
import { GlassView } from './GlassView'
import { useHeaderSlot } from './headerSlot'
import { usePinned } from './pinnedGlass'
import type { PinnedHead } from './pinnedHead'
import {
  useActiveLayout,
  useActiveRef,
  usePageActive,
  usePageHeadHidden,
  usePageOffset
} from './TabPages'

/**
 * The parts of a screen whose head is pinned by `usePinnedHead`: the band
 * holding the card, the band holding the pills under it, the selected tab's
 * content, and the space after it. A screen places them in this order in its
 * `Screen` and the hook does the rest.
 */

/** The band holding the card that scrolls away under the header. */
export function CardBand(props: {
  part: PinnedHead['cardBand']
  /** Outside a column with its gaps: none of them to reach over. */
  flat?: boolean
  children: React.ReactNode
}): React.ReactElement {
  const { part, flat = false, children } = props
  const styles = getStyles(useTheme())
  const { headerHeight } = useHeaderSlot()
  return (
    <Band
      ref={useActiveRef(part.ref)}
      onLayout={useActiveRef(part.handleLayout)}
      style={[
        styles.band,
        styles.cardBand,
        !flat && styles.cardBandSpacing,
        part.style
      ]}
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

/**
 * The band holding the pills, which pins under the header, and carries the
 * header's glass down over itself as it comes: one pane from the top of the
 * screen, growing from the header's lower edge as the band rises to it and
 * reaching the band's lower edge as it pins (`glassGrowth`), while the header
 * draws none of its own. What scrolls under the pills blurs exactly as it
 * does under the header, with no seam where two panes would meet.
 */
export function PillBand(props: {
  part: PinnedHead['pillBand']
  testID?: string
  /** Outside a column with its gaps: none of them to take back. */
  flat?: boolean
  children: React.ReactNode
}): React.ReactElement {
  const { part, testID, flat = false, children } = props
  const styles = getStyles(useTheme())
  // Where pages share one head (an event's sliding panes), only the page on
  // show holds the pane the head writes to, and only it draws the glass.
  const active = usePageActive()
  const reported = usePinned(part.glassKey)
  const glassy = active && reported
  // The band is only as wide as the column, which a wide window centres;
  // the pane reaches a window's width past it either way, and the scene's
  // scroller clips it to the scene, so the glass spans the whole header
  // beside the sidebar.
  const { width } = useWindowDimensions()
  return (
    <Band
      testID={testID ?? 'pill-band'}
      ref={useActiveRef(part.ref)}
      onLayout={useActiveRef(part.handleLayout)}
      style={[
        styles.band,
        styles.pillBand,
        !flat && styles.pillBandSpacing,
        glassy && styles.bandClear,
        part.style
      ]}
    >
      {/*
        Placed and sized from the scroll by the head, every frame; the glass
        itself is drawn only while the header has handed its own over.
      */}
      <Animated.View
        ref={useActiveRef(part.glassRef)}
        testID="pill-band-glass"
        pointerEvents="none"
        style={[
          styles.glassPane,
          { left: -width, right: -width },
          part.glassStyle
        ]}
      >
        {glassy && (
          <>
            <GlassView style={styles.glassFill} />
            <View style={styles.glassEdge} />
          </>
        )}
      </Animated.View>
      {/*
        Otherwise, a sliver of the page above the pills, under the header's
        lower edge. iOS's glass blurs less at its very edge, and a row
        passing under it showed sharp there, just above the pinned pills.
      */}
      {!glassy && (
        <View
          pointerEvents="none"
          style={[styles.backdrop, { top: -GLASS_EDGE, height: GLASS_EDGE }]}
        />
      )}
      {children}
    </Band>
  )
}

/**
 * One view for whichever tab is showing. Give it `key={tab}`, so each tab is
 * a new view: the anchor measures it, and a tab that is new to the page has
 * to be laid out before it can be. Inside a `TabPages` the page sliding out
 * lets go of the shared ref and layout handler (`useActiveRef`).
 */
export function PinnedContent(props: {
  part: PinnedHead['content']
  testID?: string
  children: React.ReactNode
}): React.ReactElement {
  const { part, testID, children } = props
  const styles = getStyles(useTheme())
  // Measured in the column, wherever a pill page puts it: the page's own
  // offset is added once the page knows it, and the last layout is reported
  // again whenever it moves, and when a page that started sliding out comes
  // back (a pill reversed mid-slide), which no layout event says.
  const offset = usePageOffset()
  const { handleLayout } = part
  const onLayout = useActiveLayout(
    handleLayout == null
      ? undefined
      : event => {
          if (offset == null) return
          const { layout } = event.nativeEvent
          handleLayout({
            ...event,
            nativeEvent: {
              ...event.nativeEvent,
              layout: { ...layout, y: layout.y + offset }
            }
          })
        },
    offset
  )
  return (
    <View
      testID={testID}
      ref={useActiveRef(part.ref)}
      onLayout={onLayout}
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
      ref={useActiveRef(part.ref)}
      onLayout={useActiveRef(part.handleLayout)}
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
  testID?: string
  children: React.ReactNode
  ref?: React.Ref<React.ComponentRef<typeof View>>
  onLayout?: (event: LayoutChangeEvent) => void
  style: React.ComponentProps<typeof Animated.View>['style']
}): React.ReactElement {
  const { children, testID, ref, onLayout, style } = props
  const inset = useContentInset()
  const hidden = usePageHeadHidden()
  return (
    <Animated.View
      testID={testID}
      ref={ref}
      onLayout={onLayout}
      style={[
        {
          marginLeft: -inset.left,
          marginRight: -inset.right,
          paddingLeft: inset.left,
          paddingRight: inset.right
        },
        style,
        hidden && { opacity: 0 }
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
    elevation: 8
  },
  cardBandSpacing: {
    // Over the column's top margin and the gap down to the pills, so a held
    // card hides what has scrolled up under it.
    marginTop: -theme.rem(theme.spaceLgRem),
    paddingTop: theme.rem(theme.spaceLgRem),
    marginBottom: -theme.rem(theme.spaceLgRem),
    paddingBottom: theme.rem(theme.spaceLgRem)
  },
  pillBand: {
    zIndex: 3,
    elevation: 9
  },
  bandClear: {
    backgroundColor: 'transparent'
  },
  // The header's glass, from the top of the screen down to however far it
  // has grown: the head sets its top and height.
  glassPane: {
    position: 'absolute'
  },
  glassFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0
  },
  // The header's lower line, carried down at the glass's lower edge.
  glassEdge: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    backgroundColor: theme.glassBorderColor
  },
  pillBandSpacing: {
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
