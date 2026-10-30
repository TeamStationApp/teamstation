import React, { useCallback, useLayoutEffect, useRef } from 'react'
import { View } from 'react-native'

import { usePageScrollSource } from '../components/pageScroll'
import { pageScroller, Published } from '../components/PageScrollView'
import { PinnedSpacer } from '../components/PinnedBands'
import { SlidingContent, useActiveRef } from '../components/TabPages'
import { PHONE_MARGIN } from '../layout/watch'
import { useTheme } from '../theme/ThemeContext'
import { GameWatchHead, uprightColumn } from './GameWatchHead'
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
    style,
    contentStyle,
    pagedList
  } = props
  const theme = useTheme()
  // A pane sliding out lets go of the pinned head's scroller and its
  // handlers, as `Screen` does.
  const handleLayout = useActiveRef(pinned.screen.onLayout)
  const sharedScroll = useActiveRef(pinned.screen.onScroll)
  const listRef = useRef<HTMLElement | null>(null)
  const fitList = useCallback(() => {
    const node = listRef.current
    if (node == null || typeof node.getBoundingClientRect !== 'function') return
    const room = window.innerHeight - node.getBoundingClientRect().top
    node.style.maxHeight = `${Math.max(120, Math.round(room))}px`
  }, [])
  // Side by side the list pane scrolls by itself, and its list follows that.
  const pane = usePageScrollSource()
  const { attachElement } = pane
  useLayoutEffect(() => {
    if (pagedList === true && sideBySide && listRef.current != null)
      attachElement(listRef.current)
  }, [attachElement, pagedList, sideBySide])
  const Scroller = pageScroller(pagedList)
  return (
    <Scroller
      ref={useActiveRef(pinned.screen.scrollRef)}
      onLayout={handleLayout}
      style={style}
      onScroll={event => {
        if (typeof sharedScroll === 'function') sharedScroll(event)
        fitList()
      }}
      scrollEventThrottle={16}
      contentContainerStyle={{ paddingTop: headerHeight }}
    >
      <View style={[contentStyle, !short && uprightColumn(theme)]}>
        <GameWatchHead
          pinned={pinned}
          head={head}
          sections={sections}
          short={short}
        />
        <SlidingContent
          ref={useActiveRef(pinned.content.ref)}
          onLayout={useActiveRef(pinned.content.handleLayout)}
          testID="eventTabContent"
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
            {pagedList === true ? (
              <Published source={pane} inert={!sideBySide}>
                {highlightList}
              </Published>
            ) : (
              highlightList
            )}
            {footer}
          </div>
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
