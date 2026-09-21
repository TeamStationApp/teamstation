import React, { useCallback, useRef } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'

import { PHONE_MARGIN } from '../layout/watch'
import { useTheme } from '../theme/ThemeContext'
import type { GameWatchLayoutProps } from './gameWatchLayoutProps'

export type { GameWatchLayoutProps }

/**
 * Where the picture, the card and the highlights go while a game is watched.
 *
 * One container, three children, always in this order. Stacked it is a column
 * that scrolls, with the picture pegged under the header once the card has
 * gone by; side by side it is a wrapping row, where the card takes the full
 * width and the picture and the list share the line below.
 *
 * **The same parent and the same children in both**, because the player must
 * not move in the tree: a layout that swapped one structure for another would
 * remount it and stop playback dead the moment a window crossed the boundary.
 *
 * This is the one region of the app that exists twice. The arrangement is
 * written in the browser's own vocabulary — `position: sticky` and an
 * `overflow` that scrolls — and neither has a React Native equivalent that is
 * a style rather than a component, so `GameWatchLayout.native.tsx` rebuilds
 * the same three-part arrangement out of what a phone has. Everything the two
 * files draw arrives as a `ReactNode`: neither knows what a game is, which is
 * what keeps one screen from quietly becoming two.
 */
export function GameWatchLayout(
  props: GameWatchLayoutProps
): React.ReactElement {
  const {
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
    headStyle,
    columnHeadStyle
  } = props
  const theme = useTheme()
  const listRef = useRef<HTMLElement | null>(null)

  /**
   * The highlights column runs to the bottom of the window, wherever it starts.
   *
   * A fixed height cut it off at the picture's lower edge while the card was
   * still on screen, so the rows ended in mid-air and the last of them could
   * not be reached until the card had gone. Its height is set from where it
   * actually is, on every scroll, which is cheap next to what the browser is
   * already doing to scroll.
   */
  const fitList = useCallback(() => {
    const node = listRef.current
    if (node == null || typeof node.getBoundingClientRect !== 'function') return
    const room = window.innerHeight - node.getBoundingClientRect().top
    node.style.maxHeight = `${Math.max(120, Math.round(room))}px`
  }, [])

  return (
    <Animated.ScrollView
      style={style}
      onScroll={() => {
        onScroll()
        fitList()
      }}
      scrollEventThrottle={16}
      contentContainerStyle={contentStyle}
    >
      {/*
        The card and the sections, above everything on a window with the
        height for them.

        Short, they are in the column on the right instead. A band across
        the top costs a phone held sideways half of what it has, and the
        picture — the thing the screen is for — would start below the fold
        and need scrolling to before it could be seen at all.
      */}
      {short ? null : <View style={headStyle}>{head}</View>}

      {/*
        A plain div, not a `View`: `position: sticky` is a web value React
        Native has no name for, and react-native-web drops it on the way
        through style validation — the block simply scrolled away, which
        looks like a working peg right up until the card has gone.
      */}
      <div
        style={{
          // A raw div is content-box by default, unlike everything React
          // Native renders: without this the padding is added to the width
          // and the block runs past the edge of the screen.
          boxSizing: 'border-box',
          position: 'sticky',
          top: headerHeight,
          zIndex: 2,
          alignSelf: 'flex-start',
          display: 'flex',
          flexDirection: 'column',
          alignItems: sideBySide ? 'flex-start' : 'center',
          paddingLeft: sideBySide ? theme.rem(theme.spaceMdRem) : 0,
          width: sideBySide ? undefined : '100%'
          // Nothing painted here. The picture is opaque on its own and the
          // card below it is the glass; a tint on this block as well stacked
          // with the card's and turned it solid.
        }}
      >
        {player}
        {/*
          Under the picture, unless there is no room: on a phone held
          sideways the picture already reaches the bottom of the window, so
          the description goes into the column that scrolls instead of off
          the end of the one that does not.
        */}
        {short ? null : description}
      </div>

      {/*
        Its own scroller beside the video, bounded by the window: the page
        stops scrolling once the card has gone, and the list carries on
        against a video that has stopped moving.
      */}
      <div
        ref={node => {
          listRef.current = node
          // Once it exists, and again whenever the layout changes under it.
          if (node != null) requestAnimationFrame(fitList)
        }}
        style={{
          boxSizing: 'border-box',
          flexGrow: sideBySide ? 0 : 1,
          width: sideBySide ? layout.sideWidth : '100%',
          // The same inset as the picture, so a row and the picture share
          // their left and right edges and nothing appears beside the card
          // that is pegged over them.
          paddingLeft: sideBySide ? 0 : PHONE_MARGIN,
          paddingRight: sideBySide ? theme.rem(theme.spaceMdRem) : PHONE_MARGIN,
          // A starting value only; `fitList` measures the real one.
          maxHeight: sideBySide ? height - headerHeight : undefined,
          // Pulled up past the section pills into the empty space beside
          // them. Short, the pills are in this column rather than beside
          // it, so there is nothing to pull past.
          marginTop:
            sideBySide && !short
              ? -(tabsHeight + theme.rem(theme.spaceSmRem))
              : 0,
          overflowY: sideBySide ? 'auto' : 'visible'
        }}
      >
        {/*
          The sections only. The card itself is not drawn on a short window
          — a column narrow enough to sit beside the picture is narrower
          than two team names laid out either side of a score, and the
          header is already holding that score in full.
        */}
        {short ? <View style={columnHeadStyle}>{sections}</View> : null}
        {short ? description : null}
        {highlightList}
        {footer}
      </div>
    </Animated.ScrollView>
  )
}
