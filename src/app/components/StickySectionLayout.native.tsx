import React from 'react'
import { View } from 'react-native'
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useComposedEventHandler,
  useSharedValue
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

import { edgeMarginRem } from '../layout/margins'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import { ContentInsetContext } from './contentInset'
import { useHeaderSlot } from './headerSlot'
import { useNavAnimatedScroll, useNavCompactScroll } from './navCompact'
import { pageScroller } from './PageScrollView'
import { useScreenBottom } from './Screen'
import type { StickySectionLayoutProps } from './stickySectionLayoutProps'
import { useBreakpoint } from './useBreakpoint'

/** Native counterpart of CSS sticky, measured against the overlaid header. */
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
                backgroundColor: theme.backgroundColor
              },
              pegStyle
            ]}
          >
            {sections}
          </Animated.View>
          {children}
        </ContentInsetContext.Provider>
      </View>
    </Scroller>
  )
}
