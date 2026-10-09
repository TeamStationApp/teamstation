import type React from 'react'
import type { View } from 'react-native'
import type { SharedValue } from 'react-native-reanimated'

/** How far the source travels past the header before the copy is fully in. */
export const HANDOFF_RAMP = 48

/**
 * What a screen gets back from `useHandoff`, shared by both implementations.
 *
 * In a third module because a native sibling cannot import from its own web
 * twin — Metro resolves the import back to the sibling itself.
 */
export interface Handoff {
  /** 0 while the source is in view, 1 once it has passed under the header. */
  progress: SharedValue<number>
  /**
   * Put on the thing that scrolls away — a card, a row of pills.
   *
   * A `React.Ref` rather than the callback the web file happens to use,
   * because the native sibling hands back an animated ref instead: it measures
   * the same rectangle on the animation thread, where a browser can simply be
   * asked.
   */
  ref: React.Ref<React.ComponentRef<typeof View>>
  /**
   * Put on the screen's scroll view, and called directly wherever the layout
   * has changed under the source without anybody scrolling.
   *
   * It takes no argument on purpose. Both implementations read the source's
   * position at the moment they are asked rather than deriving it from a
   * scroll offset, so a call site does not have to have an event to hand.
   */
  handleScroll: () => void
}
