import type React from 'react'
import type { LayoutChangeEvent, View } from 'react-native'
import type Animated from 'react-native-reanimated'

import type { ScreenProps } from './Screen'

type ViewStyleProp = React.ComponentProps<typeof View>['style']
/** A band's style: animated on the phone, empty in the browser. */
type BandStyle = React.ComponentProps<typeof Animated.View>['style']

/**
 * Where a screen's head — a card, and the pills under it — is drawn while the
 * page scrolls, as two numbers.
 *
 * `y` is the scroll offset. `collapse` is how far the head has gone up under
 * the header: never more than `y`, and with no upper limit. A plain scroll
 * from the top keeps the two equal, and then the head is nothing more than a
 * card that scrolls away and pills that stick under the header.
 *
 * They part only when a tab is selected. The selected tab's content is then
 * scrolled to where it should start — a team's schedule, at its next game —
 * without moving the head: `y` jumps and `collapse` stays. From there,
 * scrolling up raises `collapse` exactly as far as the content moved, so the
 * card and pills go up with the rows until the pills pin; scrolling down
 * leaves the head where it is, and shows what is above, until the content is
 * back at its top. That is the whole of the behaviour, and it lives here once
 * so the browser and the phone cannot come to disagree about it.
 *
 * Every function is a worklet: the phone runs them on the animation thread,
 * where the scroll happens, and the browser simply calls them.
 */
export interface HeadState {
  y: number
  collapse: number
}

export const AT_REST: HeadState = { y: 0, collapse: 0 }

/** The head after the page has scrolled to `y`. */
export function scrolled(state: HeadState, y: number): HeadState {
  'worklet'
  const up = Math.max(0, y - state.y)
  return { y, collapse: Math.min(state.collapse + up, Math.max(0, y)) }
}

/** How far the card is drawn below where the page would put it. */
export function cardOffset(state: HeadState): number {
  'worklet'
  return Math.max(0, state.y - state.collapse)
}

/**
 * How far the pills are drawn below where the page would put it. `pinAt` is
 * how far the page scrolls before the pills meet the header: past it, they
 * stay there.
 */
export function pillsOffset(state: HeadState, pinAt: number): number {
  'worklet'
  return Math.max(0, state.y - Math.min(state.collapse, pinAt))
}

/**
 * The head after a tab is selected: the tab's content is scrolled so that
 * `rowOffset` into it — the schedule's next game, or 0 for the top — starts
 * directly under the pills, wherever the pills are now. The card does not
 * move unless it was already under the header, and then it stays there.
 */
export function anchored(
  state: HeadState,
  rowOffset: number,
  pinAt: number
): HeadState {
  'worklet'
  const y = rowOffset + Math.min(state.collapse, pinAt)
  return { y, collapse: Math.min(state.collapse, y) }
}

/**
 * The space a tab needs after its content so the page can scroll to
 * `target`: nothing when the content is long enough, otherwise exactly the
 * shortfall. `contentBottom` is where the content ends, measured from the
 * top of the page.
 *
 * The target asked for is the pinned one, `rowOffset + pinAt`: enough to
 * hold the anchor, and enough to drag up from it until the pills pin, however
 * short the tab — a finished season, an empty schedule.
 */
export function spacerFor(
  target: number,
  contentBottom: number,
  viewportHeight: number
): number {
  'worklet'
  return Math.max(0, target + viewportHeight - contentBottom)
}

/** Whether the head is where a plain scroll from the top would put it. */
export function inStep(state: HeadState): boolean {
  'worklet'
  return state.collapse >= state.y
}

/**
 * What a screen tells `usePinnedHead`, shared by the browser and phone
 * implementations — a native twin cannot import its web sibling.
 */
export interface PinnedHeadOptions {
  headerHeight: number
  /** The content has loaded, so a pending anchor may run. */
  ready: boolean
  /** Which tab is showing: a new one is laid out before it is anchored. */
  tab: string
  /** The tab anchors on `nextRow` rather than at its top. */
  anchorOnRow: boolean
  /**
   * What the page always has below the room after the content — on the team
   * screen, the screen's own bottom margin. (The room takes back the column's
   * gap before it, so that gap is not counted.) The room is sized with this
   * counted, so the page stops exactly where the pills pin over the anchored
   * row rather than scrolling it away under them.
   */
  tail: number
  /** Called after every scroll, once the head has moved: the hand-off. */
  onScroll: () => void
  /** Another ref for the card band: the hand-off measures the same box. */
  cardRef?: React.Ref<React.ComponentRef<typeof View>>
}

interface Part {
  ref?: React.Ref<React.ComponentRef<typeof View>>
  handleLayout?: (event: LayoutChangeEvent) => void
}

/** What `usePinnedHead` hands back: props for each part of the screen. */
export interface PinnedHead {
  /** For `Screen`. */
  screen: {
    onScroll: ScreenProps['onScroll']
    scrollRef?: ScreenProps['scrollRef']
    onLayout?: (event: LayoutChangeEvent) => void
  }
  /** The band holding the card, and the band holding the pills. */
  cardBand: Part & { style: BandStyle }
  pillBand: Part & { style: BandStyle }
  /**
   * The selected tab's content, and on the schedule its next game and the
   * section holding it (the phone measures the row from its section).
   */
  content: Part
  nextRow: Part
  rowSection: Part
  /** The space after the content. */
  spacer: Part & { style: ViewStyleProp }
  /**
   * Call as a tab is selected, before it is shown. The head holds still, and
   * the new tab is anchored once it has been laid out.
   */
  select: (tab: string) => void
}
