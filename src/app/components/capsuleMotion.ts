import { Easing, ReduceMotion, withTiming } from 'react-native-reanimated'

/**
 * Every change of the capsule (the highlight sliding to a tab, the drag lens
 * growing and settling, the bar compacting or expanding) eases to a stop. A
 * spring would overshoot its target and swing back; an ease-out curve only
 * slows down as it arrives.
 */
const easeOut = Easing.out(Easing.cubic)

export const CAPSULE_TIMING = {
  duration: 250,
  // A first frame can arrive a moment before the animation's start time, and
  // the cubic would carry that negative progress back past the start value.
  easing: (progress: number): number => {
    'worklet'
    return easeOut(Math.min(1, Math.max(0, progress)))
  },
  // useMotionPreference follows the setting live, and capsuleMotion applies it.
  reduceMotion: ReduceMotion.Never
}

/** Reduce Motion moves straight to the target. */
export function capsuleMotion(target: number, reducedMotion: boolean): number {
  return reducedMotion ? target : withTiming(target, CAPSULE_TIMING)
}
