import React, { useState } from 'react'
import { type LayoutChangeEvent, View } from 'react-native'
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useComposedEventHandler,
  useSharedValue
} from 'react-native-reanimated'

import { PinnedSpacer } from '../components/PinnedBands'
import { PHONE_MARGIN } from '../layout/watch'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import type { GameWatchLayoutProps } from './gameWatchLayoutProps'

export type { GameWatchLayoutProps }

/**
 * The upright column's cap: none that any list reaches. A number rather than
 * no key at all, because an animated style keeps the last value of a key it
 * stops returning (see `listStyle`).
 */
const UNCAPPED = 1_000_000

/** Native arrangement of the same pinned sections and pegged video as the web. */
export function GameWatchLayout(
  props: GameWatchLayoutProps
): React.ReactElement {
  const {
    pinned,
    head,
    player,
    description,
    sections,
    highlightList,
    footer,
    layout,
    short,
    sideBySide,
    headerHeight,
    tabsHeight,
    height,
    style,
    contentStyle,
    headStyle
  } = props
  const theme = useTheme()
  const handleLayout = pinned.screen.onLayout
  const insets = useInsets()
  const scrollY = useSharedValue(0)
  const bodyTop = useSharedValue(0)
  const pegTop = useSharedValue(0)
  const pegHeight = useSharedValue(0)
  const contentHeight = useSharedValue(0)
  const listTop = useSharedValue(0)
  const [columnWidth, setColumnWidth] = useState<number | undefined>(undefined)
  const handleScroll = useAnimatedScrollHandler(event => {
    scrollY.value = event.contentOffset.y
  })
  // The native pinned-head implementation always supplies a Reanimated handler.
  const onPageScroll = useComposedEventHandler([
    handleScroll,
    pinned.screen.onScroll as typeof handleScroll
  ])
  const pegStyle = useAnimatedStyle(() => {
    const wanted = scrollY.value + tabsHeight - bodyTop.value - pegTop.value
    const room =
      contentHeight.value -
      headerHeight -
      bodyTop.value -
      pegTop.value -
      pegHeight.value
    return {
      transform: [
        { translateY: Math.min(Math.max(0, wanted), Math.max(0, room)) }
      ]
    }
  })
  const listStyle = useAnimatedStyle(() => {
    // Upright, the column is as tall as everything in it, and has to say so.
    // Returning no `maxHeight` left the sideways cap on the view: Android's
    // streaming screen turns the phone sideways under this tab and back, and
    // the column, which does not scroll upright, then cut off the cameras'
    // upload rows and Record video with no way to reach them.
    if (!sideBySide) return { maxHeight: UNCAPPED }
    const top = headerHeight + bodyTop.value + listTop.value - scrollY.value
    return { maxHeight: Math.max(120, height - top) }
    // Named, so it is worked out again when the phone turns wherever the
    // worklet's closure is not tracked for it (a build without the plugin).
  }, [sideBySide, height, headerHeight])
  const measurePeg = (event: LayoutChangeEvent): void => {
    pegTop.value = event.nativeEvent.layout.y
    pegHeight.value = event.nativeEvent.layout.height
  }
  return (
    <Animated.ScrollView
      ref={pinned.screen.scrollRef}
      onLayout={handleLayout}
      style={style}
      // A tap on a button in a dialog opened from this tab (Record video's
      // camera angle prompt) acts while the keyboard is up, rather than only
      // putting the keyboard away.
      keyboardShouldPersistTaps="handled"
      onScroll={onPageScroll}
      scrollEventThrottle={16}
      onContentSizeChange={(_width, contentY) => {
        contentHeight.value = contentY
      }}
      contentContainerStyle={{
        paddingTop: headerHeight,
        paddingLeft: insets.left,
        paddingRight: insets.right
      }}
    >
      <View style={contentStyle}>
        <Animated.View
          ref={pinned.cardBand.ref}
          onLayout={pinned.cardBand.handleLayout}
          style={[!short && headStyle, pinned.cardBand.style]}
        >
          {short ? null : head}
        </Animated.View>
        <Animated.View
          testID="event-pill-band"
          ref={pinned.pillBand.ref}
          onLayout={pinned.pillBand.handleLayout}
          style={[
            {
              width: '100%',
              paddingHorizontal: theme.rem(theme.spaceMdRem),
              zIndex: 3,
              elevation: 3,
              backgroundColor: theme.backgroundColor
            },
            pinned.pillBand.style
          ]}
        >
          {sections}
        </Animated.View>
        <View
          ref={pinned.content.ref}
          testID="eventTabContent"
          onLayout={event => {
            bodyTop.value = event.nativeEvent.layout.y
            pinned.content.handleLayout?.(event)
          }}
          style={{
            width: '100%',
            flexDirection: sideBySide ? 'row' : 'column',
            alignItems: 'flex-start',
            columnGap: theme.rem(1.5)
          }}
        >
          <Animated.View
            testID="event-pegged-video"
            onLayout={measurePeg}
            style={[
              {
                zIndex: 2,
                elevation: 2,
                alignSelf: 'flex-start',
                alignItems: sideBySide ? 'flex-start' : 'center',
                paddingLeft: sideBySide ? theme.rem(theme.spaceMdRem) : 0,
                width: sideBySide ? undefined : '100%'
              },
              pegStyle
            ]}
          >
            {player}
            {short ? null : description}
          </Animated.View>
          <Animated.ScrollView
            scrollEnabled={sideBySide}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            onLayout={event => {
              listTop.value = event.nativeEvent.layout.y
              setColumnWidth(
                sideBySide ? layout.sideWidth : event.nativeEvent.layout.width
              )
            }}
            style={[
              {
                flexGrow: sideBySide ? 0 : 1,
                width: sideBySide ? layout.sideWidth : '100%'
              },
              listStyle
            ]}
            contentContainerStyle={{
              paddingLeft: sideBySide ? 0 : PHONE_MARGIN,
              paddingRight: sideBySide
                ? theme.rem(theme.spaceMdRem)
                : PHONE_MARGIN,
              width: columnWidth
            }}
          >
            {short ? description : null}
            {highlightList}
            {footer}
          </Animated.ScrollView>
        </View>
        <PinnedSpacer
          part={{
            ...pinned.spacer,
            style: [
              pinned.spacer.style,
              { marginTop: -theme.rem(theme.spaceSmRem) }
            ]
          }}
        />
      </View>
    </Animated.ScrollView>
  )
}
