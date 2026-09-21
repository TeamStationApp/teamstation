import type React from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

import type { WatchLayout } from '../layout/watch'

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
  /** The card and the section pills, drawn above everything where they fit. */
  head: React.ReactNode
  /** The picture, and the camera-angle strip under it. */
  player: React.ReactNode
  /** The chosen play's full account. */
  description: React.ReactNode
  /** The section pills on their own, for the narrow column. */
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
  /** How far the section pills push the highlights down. */
  tabsHeight: number
  /** The window's height, for the column that has to end at the bottom of it. */
  height: number
  /**
   * The page moved.
   *
   * Deliberately no event. The one thing above this that cares — the header
   * hand-off — reads the source's position at the moment it is asked rather
   * than deriving it from an offset, and the native layout needs the scroll
   * event for its own purposes and cannot pass a second handler down.
   */
  onScroll: () => void
  style?: StyleProp<ViewStyle>
  contentStyle?: StyleProp<ViewStyle>
  headStyle?: StyleProp<ViewStyle>
  columnHeadStyle?: StyleProp<ViewStyle>
}
