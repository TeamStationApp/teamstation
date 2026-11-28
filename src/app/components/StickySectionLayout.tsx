import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useWindowDimensions, View } from 'react-native'
import type Animated from 'react-native-reanimated'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { GlassView } from './GlassView'
import { useHeaderSlot } from './headerSlot'
import { markPinned, usePinned } from './pinnedGlass'
import { glassGrowth } from './pinnedHead'
import { useSceneTop } from './sceneTop'
import { Screen } from './Screen'
import type { StickySectionLayoutProps } from './stickySectionLayoutProps'

type Scroller = React.ComponentRef<typeof Animated.ScrollView>

/**
 * The same section strip stays below the glass header after its hero leaves,
 * and carries the header's glass down over itself as it comes: one pane from
 * the top of the screen, growing from the header's lower edge over the last
 * section-height of the scroll and reaching the section's lower edge as it
 * pins (`glassGrowth`), while the header draws none of its own. On the
 * umpire schedule that is the whole pinned stack: tabs, Chat and the column
 * headers.
 */
export function StickySectionLayout({
  hero,
  sections,
  children,
  onScroll,
  wide,
  scrollRef,
  contentStyle,
  pagedList
}: StickySectionLayoutProps): React.ReactElement {
  const { headerHeight } = useHeaderSlot()
  const theme = useTheme()
  const styles = getStyles(theme)
  const { width } = useWindowDimensions()
  /** Zero tall, where the section's top is when it is not stuck. */
  const marker = useRef<HTMLDivElement>(null)
  const section = useRef<HTMLDivElement>(null)
  /** The pane of the header's glass the section grows down over itself. */
  const pane = useRef<HTMLDivElement>(null)
  /** The element that scrolls: the `Screen`'s scrollable node. */
  const scroller = useRef<HTMLElement | null>(null)
  const header = useRef(headerHeight)
  header.current = headerHeight
  /** This layout's key in `pinnedGlass`. */
  const glassKey = useRef({}).current
  /** Whether the pane has started to grow, as the last update left it. */
  const grown = useRef(false)
  // Only the stack's top hands the header anything: a section pinned beneath
  // a pushed screen leaves that screen's header as it is.
  const top = useSceneTop()
  const topRef = useRef(top)
  topRef.current = top
  const carried = usePinned(glassKey)

  /** Places the pane from the scroll and says whether it has grown. */
  const update = useCallback((): void => {
    const mark = marker.current
    const column = mark?.parentElement
    // The marker stands in the column's flow, so the gap after it is taken
    // back: the section sits where it would with no marker before it.
    if (mark != null && column != null) {
      const gap = parseFloat(getComputedStyle(column).rowGap)
      mark.style.marginBottom = `${Number.isFinite(gap) ? -gap : 0}px`
    }
    const node = scroller.current
    const box = section.current
    if (node == null || mark == null || box == null) return
    const scrollTop = node.scrollTop
    const pinAt =
      mark.getBoundingClientRect().top -
      node.getBoundingClientRect().top +
      scrollTop -
      header.current
    const height = box.offsetHeight
    const { reach, progress } = glassGrowth(
      { y: scrollTop, collapse: pinAt },
      pinAt,
      height
    )
    if (pane.current != null) {
      pane.current.style.top = `${-(header.current + reach)}px`
      pane.current.style.height = `${header.current + progress * height}px`
    }
    grown.current = progress > 0
    markPinned(glassKey, grown.current && topRef.current)
  }, [glassKey])

  useLayoutEffect(() => {
    markPinned(glassKey, grown.current && top)
  }, [glassKey, top])
  useEffect(
    () => () => {
      markPinned(glassKey, false)
    },
    [glassKey]
  )
  // A new header height moves the pin.
  useLayoutEffect(update, [update, headerHeight])
  // The section, or anything above it, changing size moves the pin too.
  useEffect(() => {
    const box = section.current
    const column = marker.current?.parentElement
    if (box == null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      update()
    })
    observer.observe(box)
    if (column != null) observer.observe(column)
    return () => {
      observer.disconnect()
    }
  }, [update])

  // The caller's ref still gets the scroller; this layout keeps its node.
  const handleScrollRef = useCallback(
    (instance: Scroller | null): void => {
      const view = instance as {
        getScrollableNode?: () => unknown
      } | null
      const node = view?.getScrollableNode?.() ?? view
      scroller.current = node instanceof HTMLElement ? node : null
      if (typeof scrollRef === 'function') scrollRef(instance)
      else if (scrollRef != null) scrollRef.current = instance
      update()
    },
    [scrollRef, update]
  )
  const handleScroll = useCallback((): void => {
    update()
    onScroll()
  }, [onScroll, update])

  return (
    <Screen
      onScroll={handleScroll}
      wide={wide}
      scrollRef={handleScrollRef}
      contentStyle={contentStyle}
      pagedList={pagedList}
    >
      {hero}
      <div ref={marker} data-testid="sticky-section-marker" />
      <div
        ref={section}
        data-testid="sticky-season-sections"
        style={{
          position: 'sticky',
          top: headerHeight,
          zIndex: 3,
          backgroundColor: carried ? 'transparent' : theme.backgroundColor
        }}
      >
        {/*
          Placed and sized from the scroll on every scroll and layout; the
          glass itself is drawn only while the header has handed its own
          over. The section is only as wide as its column, so the pane
          reaches a window's width past it each way and the scroller clips
          it to the scene. Behind the section's own content.
        */}
        <div
          ref={pane}
          data-testid="sticky-section-glass"
          style={{
            position: 'absolute',
            left: -width,
            right: -width,
            top: -headerHeight,
            height: headerHeight,
            zIndex: -1,
            pointerEvents: 'none'
          }}
        >
          {carried && (
            <>
              <GlassView style={styles.fill} />
              <View style={styles.edge} />
            </>
          )}
        </div>
        {sections}
      </div>
      {children}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0
  },
  // The header's lower line, carried down at the glass's lower edge.
  edge: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    backgroundColor: theme.glassBorderColor
  }
}))
