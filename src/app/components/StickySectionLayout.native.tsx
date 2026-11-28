import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useWindowDimensions, View } from 'react-native'
import Animated, {
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useComposedEventHandler,
  useSharedValue
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

import { edgeMarginRem } from '../layout/margins'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ContentInsetContext } from './contentInset'
import { GlassView } from './GlassView'
import { useHeaderSlot } from './headerSlot'
import { useNavAnimatedScroll, useNavCompactScroll } from './navCompact'
import { pageScroller } from './PageScrollView'
import { markPinned, usePinned } from './pinnedGlass'
import { glassGrowth } from './pinnedHead'
import { useSceneTop } from './sceneTop'
import { useScreenBottom } from './Screen'
import type { StickySectionLayoutProps } from './stickySectionLayoutProps'
import { useBreakpoint } from './useBreakpoint'

/**
 * Native counterpart of CSS sticky, measured against the overlaid header.
 * The section carries the header's glass down over itself as it comes, as
 * the browser's does: one pane from the top of the screen, growing from the
 * header's lower edge over the last section-height of the scroll and
 * reaching the section's lower edge as it pins (`glassGrowth`), driven on
 * the UI thread from the scroll.
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
  const theme = useTheme()
  const styles = getStyles(theme)
  const { width } = useWindowDimensions()
  const { headerHeight } = useHeaderSlot()
  const breakpoint = useBreakpoint()
  const insets = useInsets()
  const scrollY = useSharedValue(0)
  const sectionTop = useSharedValue(0)
  const sectionHeight = useSharedValue(0)
  const contentHeight = useSharedValue(0)
  const margin = theme.rem(edgeMarginRem(theme, breakpoint))
  const side = {
    left: Math.max(margin, insets.left),
    right: Math.max(margin, insets.right)
  }
  const bottom = useScreenBottom()
  const observeNavScroll = useNavCompactScroll()
  const forNav = useNavAnimatedScroll(observeNavScroll)
  const handleScroll = useAnimatedScrollHandler(event => {
    scrollY.value = event.contentOffset.y

    scheduleOnRN(onScroll)
  })
  const pageScroll = useComposedEventHandler([handleScroll, forNav])
  const pegStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: Math.min(
          Math.max(0, scrollY.value + headerHeight - sectionTop.value),
          Math.max(
            0,
            contentHeight.value - sectionTop.value - sectionHeight.value
          )
        )
      }
    ]
  }))
  // Whether the pane has started to grow down from the header
  // (`pinnedGlass`), reported only while this scene is the stack's top: a
  // section pinned beneath a pushed screen leaves that screen's header alone.
  const glassKey = useRef({}).current
  /** What the reaction last said: it says nothing again after a Back. */
  const grown = useRef(false)
  const top = useSceneTop()
  const topRef = useRef(top)
  topRef.current = top
  const carried = usePinned(glassKey)
  useLayoutEffect(() => {
    markPinned(glassKey, grown.current && top)
  }, [glassKey, top])
  useEffect(
    () => () => {
      markPinned(glassKey, false)
    },
    [glassKey]
  )
  // Through a function made here: an object handed to the JS thread arrives
  // as a copy, which is not the key the section looks itself up by.
  const reportGrown = useCallback(
    (on: boolean): void => {
      grown.current = on
      markPinned(glassKey, on && topRef.current)
    },
    [glassKey]
  )
  useAnimatedReaction(
    () =>
      glassGrowth(
        { y: scrollY.value, collapse: sectionTop.value - headerHeight },
        sectionTop.value - headerHeight,
        sectionHeight.value
      ).progress > 0,
    (now, before) => {
      if (now !== before) scheduleOnRN(reportGrown, now)
    }
  )
  // The pane of the header's glass, frame by frame with the page.
  const glassStyle = useAnimatedStyle(() => {
    const pinAt = sectionTop.value - headerHeight
    const height = sectionHeight.value
    const { reach, progress } = glassGrowth(
      { y: scrollY.value, collapse: pinAt },
      pinAt,
      height
    )
    return {
      top: -(headerHeight + reach),
      height: headerHeight + progress * height
    }
  })
  const Scroller = pageScroller(pagedList)
  return (
    <Scroller
      ref={scrollRef}
      style={{ flex: 1, backgroundColor: theme.backgroundColor }}
      onScroll={forNav == null ? handleScroll : pageScroll}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      onContentSizeChange={(_width, height) => {
        contentHeight.value = height
      }}
      contentContainerStyle={{ paddingTop: headerHeight, alignItems: 'center' }}
    >
      <View
        style={[
          {
            width: '100%',
            maxWidth:
              wide === true ? undefined : theme.rem(theme.maxContentWidthRem),
            paddingTop: theme.rem(theme.spaceLgRem),
            paddingBottom: bottom,
            paddingLeft: side.left,
            paddingRight: side.right,
            gap: theme.rem(theme.spaceLgRem)
          },
          contentStyle
        ]}
      >
        <ContentInsetContext.Provider value={side}>
          {hero}
          <Animated.View
            testID="sticky-season-sections"
            onLayout={event => {
              sectionTop.value = headerHeight + event.nativeEvent.layout.y
              sectionHeight.value = event.nativeEvent.layout.height
            }}
            style={[
              {
                zIndex: 3,
                elevation: 3,
                backgroundColor: carried ? 'transparent' : theme.backgroundColor
              },
              pegStyle
            ]}
          >
            {/*
              Placed and sized from the scroll; the glass itself is drawn
              only while the header has handed its own over. The section is
              only as wide as its column, so the pane reaches a window's
              width past it each way and the scroller clips it.
            */}
            <Animated.View
              testID="sticky-section-glass"
              pointerEvents="none"
              style={[styles.pane, { left: -width, right: -width }, glassStyle]}
            >
              {carried && (
                <>
                  <GlassView style={styles.fill} />
                  <View style={styles.edge} />
                </>
              )}
            </Animated.View>
            {sections}
          </Animated.View>
          {children}
        </ContentInsetContext.Provider>
      </View>
    </Scroller>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  pane: {
    position: 'absolute'
  },
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
