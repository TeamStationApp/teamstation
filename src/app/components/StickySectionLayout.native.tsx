import React from 'react'
import { Platform, View } from 'react-native'
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue
} from 'react-native-reanimated'

import { edgeMarginRem } from '../layout/margins'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import { FLOATING_BOTTOM_REM, NAV_CLEARANCE_REM } from './AppNav'
import { ContentInsetContext } from './contentInset'
import { useHeaderSlot } from './headerSlot'
import { navClearanceAboveInset } from './navClearance'
import type { StickySectionLayoutProps } from './stickySectionLayoutProps'
import { useBreakpoint } from './useBreakpoint'

/** Native counterpart of CSS sticky, measured against the overlaid header. */
export function StickySectionLayout({
  hero,
  sections,
  children,
  onScroll,
  wide
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
  const bottom =
    breakpoint === 'phone'
      ? navClearanceAboveInset(
          Platform.OS,
          theme.rem(NAV_CLEARANCE_REM),
          theme.rem(FLOATING_BOTTOM_REM)
        ) + insets.bottom
      : theme.rem(theme.spaceLgRem)
  const handleScroll = useAnimatedScrollHandler(event => {
    scrollY.value = event.contentOffset.y
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- same handoff bridge as GameWatchLayout
    runOnJS(onScroll)()
  })
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
  return (
    <Animated.ScrollView
      style={{ flex: 1, backgroundColor: theme.backgroundColor }}
      onScroll={handleScroll}
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
        style={{
          width: '100%',
          maxWidth:
            wide === true ? undefined : theme.rem(theme.maxContentWidthRem),
          paddingTop: theme.rem(theme.spaceLgRem),
          paddingBottom: bottom,
          paddingLeft: side.left,
          paddingRight: side.right,
          gap: theme.rem(theme.spaceLgRem)
        }}
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
    </Animated.ScrollView>
  )
}
