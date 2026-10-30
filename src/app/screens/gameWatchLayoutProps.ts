import type React from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

import type { Handoff } from '../components/handoff'
import type { PinnedHead } from '../components/pinnedHead'
import type { WatchLayout } from '../layout/watch'

/** Every pinned-head notification keeps the header visible when its hero is omitted. */
export function watchHandoff(
  handoff: Handoff,
  shortWindow: React.RefObject<boolean>
): Handoff {
  return {
    ...handoff,
    handleScroll: () => {
      if (shortWindow.current) handoff.progress.value = 1
      else handoff.handleScroll()
    }
  }
}

/**
 * What the watch layout is handed, shared by both implementations.
 *
 * In a third module because a native sibling cannot import from its own web
 * twin: Metro resolves `./GameWatchLayout` inside `GameWatchLayout.native.tsx`
 * back to itself, and the binding is `undefined` at run time.
 *
 * **Everything drawn arrives as a `ReactNode`.** Neither file takes a game, a
 * client or a list of highlights, and that is the contract that keeps this
 * fork from spreading: with it, each side is sixty lines of arrangement and
 * nothing else moves; without it, the fork quietly becomes two copies of half
 * the game screen and the two drift apart.
 */
export interface GameWatchLayoutProps {
  /** The same pinned head used by every event section. */
  pinned: PinnedHead
  /** The card, drawn above the section pills where it fits. */
  head: React.ReactNode
  /** The picture, and the camera-angle strip under it. */
  player: React.ReactNode
  /** The chosen play's full account. */
  description: React.ReactNode
  /** The section pills, pinned across the screen above the picture. */
  sections: React.ReactNode
  highlightList: React.ReactNode
  /** The stream panel and the refresh button, at the end of the list. */
  footer: React.ReactNode
  /** Where everything goes, worked out from the window and the video's shape. */
  layout: WatchLayout
  /** A window with no height for a card above the picture. */
  short: boolean
  sideBySide: boolean
  /** The glass header this content runs under, and the picture pegs below. */
  headerHeight: number
  /** The full-width section band, which the picture and highlights clear. */
  tabsHeight: number
  /** The window's height, for the column that has to end at the bottom of it. */
  height: number
  style?: StyleProp<ViewStyle>
  contentStyle?: StyleProp<ViewStyle>
  /**
   * The highlights are a `PagedList`: it follows the page, or side by side
   * the list pane's own scroller.
   */
  pagedList?: boolean
}
