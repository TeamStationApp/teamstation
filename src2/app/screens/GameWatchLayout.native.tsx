import React, { useState } from 'react'
import { type LayoutChangeEvent, View } from 'react-native'
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue
} from 'react-native-reanimated'

import { PHONE_MARGIN } from '../layout/watch'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import type { GameWatchLayoutProps } from './gameWatchLayoutProps'

export type { GameWatchLayoutProps }

/** A sticky block may not shrink below this before it stops being worth one. */
const MIN_LIST_HEIGHT = 120

/**
 * Where the picture, the card and the highlights go while a game is watched.
 *
 * The twin of `GameWatchLayout.tsx`, and the only region of this app that
 * exists twice. The arrangement there is `position: sticky` and a nested
 * `overflow: auto` — two things a browser does with a style and a phone cannot
 * do at all — so the same three-part arrangement is rebuilt here out of what
 * React Native has. Everything drawn arrives as a `ReactNode`; this file does
 * not know what a game is, which is what stops one screen becoming two.
 *
 * **The peg is a clamped translate, not `stickyHeaderIndices`.** A sticky
 * header docks at the scroll view's own top edge, and this app's glass header
 * *overlays* the scroll view — so the picture would peg **behind** the header,
 * and the one lever that moves a sticky header down (`contentInset`) exists
 * only on iOS. The translate below reproduces `position: sticky` exactly,
 * including the part that is easy to forget: a sticky element stops at the
 * bottom of its containing block. Without that upper clamp the picture keeps
 * travelling and rides out over the stream panel at the end of the list.
 *
 * All three measurements come from `onLayout`, and the translate itself runs
 * on the animation thread, so scrolling never waits for JavaScript.
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
  // A phone held sideways puts the camera housing on one edge and a rounded
  // corner on the other, and this is the screen people hold sideways. Without
  // this the picture runs under the island.
  const insets = useInsets()

  const scrollY = useSharedValue(0)
  /** Where the pegged block sits in the content, and how tall it is. */
  const pegTop = useSharedValue(0)
  const pegHeight = useSharedValue(0)
  /** How far it may travel: to the bottom of what it is pegged inside. */
  const contentHeight = useSharedValue(0)
  /** Where the highlight column starts, for the height it is allowed. */
  const listTop = useSharedValue(0)
  const [columnWidth, setColumnWidth] = useState<number | undefined>(undefined)

  const handleScroll = useAnimatedScrollHandler(event => {
    scrollY.value = event.contentOffset.y
    // The header hand-off measures the card itself, on this same thread, but
    // it has to be told when. This is the only hop to JavaScript per frame.
    runOnJS(onScroll)()
  })

  const pegStyle = useAnimatedStyle(() => {
    // Pegged once the block's top would pass under the header, and no further
    // than the bottom of the content it is pegged inside — which is what a
    // browser's `position: sticky` does without being asked.
    const wanted = scrollY.value + headerHeight - pegTop.value
    const room = contentHeight.value - pegTop.value - pegHeight.value
    const travel = Math.min(Math.max(0, wanted), Math.max(0, room))
    return { transform: [{ translateY: travel }] }
  })

  const listStyle = useAnimatedStyle(() => {
    if (!sideBySide) return {}
    // The column runs to the bottom of the window, wherever it currently
    // starts. A fixed height cut it off at the picture's lower edge while the
    // card was still on screen, so the rows ended in mid-air and the last of
    // them could not be reached until the card had gone.
    const top = listTop.value - scrollY.value
    return { maxHeight: Math.max(MIN_LIST_HEIGHT, height - top) }
  })

  const measurePeg = (event: LayoutChangeEvent): void => {
    pegTop.value = event.nativeEvent.layout.y
    pegHeight.value = event.nativeEvent.layout.height
  }

  return (
    <Animated.ScrollView
      style={style}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      onContentSizeChange={(_width, contentY) => {
        contentHeight.value = contentY
      }}
      contentContainerStyle={[
        contentStyle,
        // The header is glass and overlays this, so everything starts below
        // it. On the container rather than on the card, because on a short
        // window the card is not the first thing here — the picture is.
        {
          paddingTop: headerHeight,
          paddingLeft: insets.left,
          paddingRight: insets.right,
          // The watch tab is the one screen that does not go through
          // `Screen`, so it is also the one that has to ask for this itself:
          // without it the last highlight sits under the home indicator on a
          // phone and under the floating nav capsule on both.
          paddingBottom: insets.bottom
        }
      ]}
    >
      {/*
        The card and the sections, above everything on a window with the
        height for them.

        Short, they are in the column on the right instead. A band across the
        top costs a phone held sideways half of what it has, and the picture —
        the thing the screen is for — would start below the fold and need
        scrolling to before it could be seen at all.
      */}
      {short ? null : <View style={headStyle}>{head}</View>}

      <Animated.View
        onLayout={measurePeg}
        style={[
          {
            zIndex: 2,
            // Android paints by elevation and ignores `zIndex` where the two
            // disagree, so the pegged picture needs both or the rows sliding
            // under it are drawn on top of it.
            elevation: 2,
            alignSelf: 'flex-start',
            alignItems: sideBySide ? 'flex-start' : 'center',
            paddingLeft: sideBySide ? theme.rem(theme.spaceMdRem) : 0,
            width: sideBySide ? undefined : '100%'
            // Nothing painted here. The picture is opaque on its own and the
            // card below it is the glass; a tint on this block as well stacked
            // with the card's and turned it solid.
          },
          pegStyle
        ]}
      >
        {player}
        {/*
          Under the picture, unless there is no room: on a phone held sideways
          the picture already reaches the bottom of the window, so the
          description goes into the column that scrolls instead of off the end
          of the one that does not.
        */}
        {short ? null : description}
      </Animated.View>

      {/*
        Its own scroller beside the video: the page stops scrolling once the
        card has gone, and the list carries on against a picture that has
        stopped moving.

        One `ScrollView` in both arrangements, with its scrolling turned off
        rather than swapped for a `View`. Swapping the component would remount
        everything below it — the player with it — the moment a window crossed
        the boundary, which is the whole thing this layout is built to avoid.
      */}
      <Animated.ScrollView
        scrollEnabled={sideBySide}
        // Without this an inner vertical scroller on Android takes the gesture
        // and the outer one never moves again.
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
            width: sideBySide ? layout.sideWidth : '100%',
            // Pulled up past the section pills into the empty space beside
            // them. Short, the pills are in this column rather than beside it,
            // so there is nothing to pull past.
            marginTop:
              sideBySide && !short
                ? -(tabsHeight + theme.rem(theme.spaceSmRem))
                : 0
          },
          listStyle
        ]}
        contentContainerStyle={{
          // The same inset as the picture, so a row and the picture share
          // their left and right edges and nothing appears beside the card
          // that is pegged over them.
          paddingLeft: sideBySide ? 0 : PHONE_MARGIN,
          paddingRight: sideBySide ? theme.rem(theme.spaceMdRem) : PHONE_MARGIN,
          width: columnWidth
        }}
      >
        {/*
          The sections only. The card itself is not drawn on a short window — a
          column narrow enough to sit beside the picture is narrower than two
          team names laid out either side of a score, and the header is already
          holding that score in full.
        */}
        {short ? <View style={columnHeadStyle}>{sections}</View> : null}
        {short ? description : null}
        {highlightList}
        {footer}
      </Animated.ScrollView>
    </Animated.ScrollView>
  )
}
