import type React from 'react'
import { useCallback } from 'react'
import type { View } from 'react-native'
import {
  measure,
  runOnUI,
  type SharedValue,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue
} from 'react-native-reanimated'

import type { Handoff } from './handoff'

export type { Handoff }

/** How far the source travels past the header before the copy is fully in. */
const RAMP = 48

/**
 * The thing you were looking at, handed up to the header as it leaves.
 *
 * The same rule as the web file, measured a different way. There it asks the
 * browser for the source's rectangle on each scroll, because asking is free;
 * here that question can only be answered on the animation thread, so it is
 * asked there — `measure` inside a worklet returns the same window-relative
 * box, and the shared value it writes is read by `useAnimatedStyle` on that
 * same thread. The scroll callback's only job is to say *when*.
 *
 * An animated ref rather than a callback ref, because `measure` needs one.
 * Nothing above this notices: the screens put `handoff.ref` on a `View` and
 * `handoff.handleScroll` on a scroll view exactly as before, and the hook
 * takes no argument on either platform so the two places that call it outside
 * a scroll — a layout that changed under the source — keep working.
 */
export function useHandoff(headerHeight: number, anchor: number = 1): Handoff {
  const progress = useSharedValue(0)
  const source = useAnimatedRef<React.ComponentRef<typeof View>>()

  const handleScroll = useCallback(() => {
    runOnUI(() => {
      'worklet'
      // The source may not exist yet. A screen asks once on its first frame —
      // before anything has been laid out — and a screen with no card to hand
      // over never attaches the ref at all; in both cases reading the tag
      // throws rather than answering, which takes the screen down.
      let box
      try {
        box = measure(source)
      } catch {
        return
      }
      if (box == null) return
      // Half in as the anchor meets the header's lower edge, with the ramp
      // spread either side of it, so the change happens *at* the thing being
      // handed over rather than after it.
      const passed = headerHeight - (box.pageY + box.height * anchor)
      const next = (passed + RAMP / 2) / RAMP
      progress.value = next < 0 ? 0 : next > 1 ? 1 : next
    })()
  }, [anchor, headerHeight, progress, source])

  return { progress, ref: source, handleScroll }
}

/** The copy's own style: it rises into place as the original leaves. */
export function useHandoffStyle(
  progress: SharedValue<number>
): ReturnType<typeof useAnimatedStyle> {
  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 8 }]
  }))
}
