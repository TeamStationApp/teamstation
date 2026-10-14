import React, { useCallback, useRef } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'

import { PinnedSpacer } from '../components/PinnedBands'
import { PHONE_MARGIN } from '../layout/watch'
import { useTheme } from '../theme/ThemeContext'
import type { GameWatchLayoutProps } from './gameWatchLayoutProps'

export type { GameWatchLayoutProps }

/** Event sections share their pinned head; the picture pegs below the pills. */
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
    onScroll,
    style,
    contentStyle,
    headStyle
  } = props
  const theme = useTheme()
  const handleLayout = pinned.screen.onLayout
  const listRef = useRef<HTMLElement | null>(null)
  const fitList = useCallback(() => {
    const node = listRef.current
    if (node == null || typeof node.getBoundingClientRect !== 'function') return
    const room = window.innerHeight - node.getBoundingClientRect().top
    node.style.maxHeight = `${Math.max(120, Math.round(room))}px`
  }, [])
  return (
    <Animated.ScrollView
      ref={pinned.screen.scrollRef}
      onLayout={handleLayout}
      style={style}
      onScroll={event => {
        if (typeof pinned.screen.onScroll === 'function')
          pinned.screen.onScroll(event)
        onScroll()
        fitList()
      }}
      scrollEventThrottle={16}
      contentContainerStyle={{ paddingTop: headerHeight }}
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
              backgroundColor: theme.backgroundColor,
              zIndex: 3
            },
            pinned.pillBand.style
          ]}
        >
          {sections}
        </Animated.View>
        <View
          ref={pinned.content.ref}
          onLayout={pinned.content.handleLayout}
          testID="eventTabContent"
          style={{
            width: '100%',
            flexDirection: sideBySide ? 'row' : 'column',
            alignItems: 'flex-start',
            columnGap: theme.rem(1.5)
          }}
        >
          <div
            data-testid="event-pegged-video"
            style={{
              boxSizing: 'border-box',
              position: 'sticky',
              top: headerHeight + tabsHeight,
              zIndex: 2,
              alignSelf: 'flex-start',
              display: 'flex',
              flexDirection: 'column',
              alignItems: sideBySide ? 'flex-start' : 'center',
              paddingLeft: sideBySide ? theme.rem(theme.spaceMdRem) : 0,
              width: sideBySide ? undefined : '100%'
            }}
          >
            {player}
            {short ? null : description}
          </div>
          <div
            ref={node => {
              listRef.current = node
              if (node != null) requestAnimationFrame(fitList)
            }}
            style={{
              boxSizing: 'border-box',
              flexGrow: sideBySide ? 0 : 1,
              width: sideBySide ? layout.sideWidth : '100%',
              paddingLeft: sideBySide ? 0 : PHONE_MARGIN,
              paddingRight: sideBySide
                ? theme.rem(theme.spaceMdRem)
                : PHONE_MARGIN,
              maxHeight: sideBySide
                ? height - headerHeight - tabsHeight
                : undefined,
              overflowY: sideBySide ? 'auto' : 'visible'
            }}
          >
            {short ? description : null}
            {highlightList}
            {footer}
          </div>
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
