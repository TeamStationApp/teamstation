import { useCallback, useRef } from 'react'
import {
  type SharedValue,
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
 * Scroll a team and its name slides into the header and stays; scroll back and
 * the header hands it down again. Every app worth using does this and ours did
 * not, so the header repeated what was already on the screen and said nothing
 * once it had gone.
 *
 * The position is read from the element itself on each scroll rather than from
 * a layout measured once. React Native's `onLayout` reports a position relative
 * to whichever ancestor the web renderer happens to make the offset parent, and
 * that changed between the first pass and later ones: the hand-over point crept
 * upwards, so scrolling back to the top left the copy sitting in the header at
 * a tenth of an opacity for ever. A rectangle read at the moment it is needed
 * cannot drift.
 */
export function useHandoff(
  headerHeight: number,
  /**
   * Where in the source the hand-over happens, as a fraction of its height.
   *
   * 1 — the bottom — suits a source that *is* the thing being copied: a row of
   * filter pills, a team's name on its own. A game's card is mostly other
   * things, and the names and the scores sit across the middle of it, so that
   * is where it should change hands.
   */
  anchor: number = 1
): Handoff {
  const progress = useSharedValue(0)
  const source = useRef<HTMLElement | null>(null)

  const ref = useCallback((node: unknown) => {
    source.current = node as HTMLElement | null
  }, [])

  const handleScroll = useCallback(() => {
    const node = source.current
    if (node == null || typeof node.getBoundingClientRect !== 'function') return
    const box = node.getBoundingClientRect()
    // Half in as the anchor meets the header's lower edge, with the ramp spread
    // either side of it, so the change happens *at* the thing being handed over
    // rather than after it.
    const passed = headerHeight - (box.top + box.height * anchor)
    const next = (passed + RAMP / 2) / RAMP
    progress.value = next < 0 ? 0 : next > 1 ? 1 : next
  }, [anchor, headerHeight, progress])

  return { progress, ref, handleScroll }
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
