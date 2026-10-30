import React, { useEffect, useState } from 'react'
import { type LayoutChangeEvent, View } from 'react-native'
import Animated, {
  type AnimatedRef,
  scrollTo,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useComposedEventHandler,
  useSharedValue
} from 'react-native-reanimated'
import { scheduleOnUI } from 'react-native-worklets'

import {
  pageScroller,
  type PageScrollViewProps
} from '../components/PageScrollView'
import { PinnedSpacer } from '../components/PinnedBands'
import {
  SlidingContent,
  useActiveLayout,
  useActiveRef
} from '../components/TabPages'
import { PHONE_MARGIN } from '../layout/watch'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import { GameWatchHead, uprightColumn } from './GameWatchHead'
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
    pagedList
  } = props
  const theme = useTheme()
  // A pane sliding out lets go of the pinned head's scroller and its
  // handlers, as `Screen` does.
  const handleLayout = useActiveRef(pinned.screen.onLayout)
  const pageRef = useActiveRef(pinned.screen.scrollRef)
  const sharedScroll = useActiveRef(pinned.screen.onScroll)
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
    (sharedScroll ?? null) as typeof handleScroll | null
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
    // Never taller than the window under the pinned head, as on the web. The
    // page can be far down when the phone turns, from reading the list
    // upright, and with no ceiling the pane took that depth as room: the
    // page then had as much again to scroll, the pane was thousands of
    // points tall, and its list drew every row for a viewport that size.
    const ceiling = height - headerHeight - tabsHeight
    return { maxHeight: Math.max(120, Math.min(ceiling, height - top)) }
    // Named, so it is worked out again when the phone turns wherever the
    // worklet's closure is not tracked for it (a build without the plugin).
  }, [sideBySide, height, headerHeight, tabsHeight])
  // Turned to side by side, the page comes back to where the pills pin, and
  // the list beside the picture starts at its top under them. Read upright to
  // the end of a long list, the page stays thousands of points down, held
  // there by the pinned head's room, and the pane, capped to the window, would
  // be that far above the screen.
  useEffect(() => {
    if (!sideBySide || pageRef == null) return
    const page = pageRef as unknown as AnimatedRef<Animated.ScrollView>
    const frame = requestAnimationFrame(() => {
      scheduleOnUI((tabs: number) => {
        'worklet'
        const pin = Math.max(0, bodyTop.value - tabs)
        if (scrollY.value > pin) scrollTo(page, 0, pin, false)
      }, tabsHeight)
    })
    return () => {
      cancelAnimationFrame(frame)
    }
    // Once a turn: the page's own scrolling after it is the reader's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBySide])
  const measurePeg = (event: LayoutChangeEvent): void => {
    pegTop.value = event.nativeEvent.layout.y
    pegHeight.value = event.nativeEvent.layout.height
  }
  const Scroller = pageScroller(pagedList)
  // Upright the pane does not scroll, and its list follows the page.
  const paneScroll: PageScrollViewProps =
    pagedList === true ? { inert: !sideBySide } : {}
  return (
    <Scroller
      ref={pageRef}
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
      <View style={[contentStyle, !short && uprightColumn(theme)]}>
        <GameWatchHead
          pinned={pinned}
          head={head}
          sections={sections}
          short={short}
          scrollerInset={insets}
        />
        <SlidingContent
          ref={useActiveRef(pinned.content.ref)}
          testID="eventTabContent"
          onLayout={useActiveLayout((event: LayoutChangeEvent) => {
            bodyTop.value = event.nativeEvent.layout.y
            pinned.content.handleLayout?.(event)
          })}
          style={{
            width: '100%',
            // Upright, the pill band takes back the column's gap; the picture
            // keeps its own small one below the pills.
            marginTop: short ? 0 : theme.rem(theme.spaceSmRem),
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
          <Scroller
            {...paneScroll}
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
          </Scroller>
        </SlidingContent>
        <PinnedSpacer
          part={{
            ...pinned.spacer,
            style: [
              pinned.spacer.style,
              {
                marginTop: -theme.rem(
                  short ? theme.spaceSmRem : theme.spaceLgRem
                )
              }
            ]
          }}
        />
      </View>
    </Scroller>
  )
}
