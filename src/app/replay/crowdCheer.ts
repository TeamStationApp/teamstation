import type React from 'react'

import type { ReplayStep } from '../../common/replay/replayTimeline'
import type { GameState } from '../../common/scoring/state'

/** How big a cheer a play raises: its file and its gain. */
export type CheerSize = 'small' | 'medium' | 'large' | 'huge'

/** The crowd under the replay, as `useCrowd` gives it on each platform. */
export interface Crowd {
  /** What to render for the crowd: hidden players, or nothing. */
  element: React.ReactElement | null
  /** Raises a cheer of `size`, while the sound is on. */
  cheer: (size: CheerSize) => void
  /**
   * Readies the crowd's sounds in the volume button's tap, so a browser
   * lets them play later; nothing on a phone.
   */
  unlock: () => void
}

/** How many cheers sound at once; another stops the oldest. */
export const MAX_CHEERS = 2

/**
 * The idle crowd's gain, under everything else: its −30 LUFS bed sits about
 * 12 dB below the smallest cheer, a −20 LUFS file at 0.55, a murmur that
 * still carries through a phone's speaker between plays.
 */
export const CROWD_IDLE_GAIN = 0.42

/**
 * How long two copies of the idle crowd's file overlap as one hands over to
 * the next, and how long the first takes to come in when the sound is on.
 */
export const CROWD_CROSSFADE_SECONDS = 2

/** How far through a ramp of CROWD_CROSSFADE_SECONDS `seconds` is, 0 to 1. */
const rampOf = (seconds: number): number =>
  Math.min(1, Math.max(0, seconds / CROWD_CROSSFADE_SECONDS))

/**
 * The gain, 0 to 1, of a copy of the idle crowd's file `position` seconds
 * into its `duration`: rising over its first CROWD_CROSSFADE_SECONDS, falling
 * over its last, 1 between. The crowd plays the file as copies that overlap
 * by CROWD_CROSSFADE_SECONDS (`nextStartsAt`), so one falls as the next
 * rises, and the very first rises too: turning the sound on brings the crowd
 * in instead of starting it at full.
 *
 * The curves are equal-power, sin(t·π/2) in and cos(t·π/2) out, t the fraction
 * through the overlap, so in² + out² = 1 throughout it. Two stretches of crowd
 * noise are uncorrelated: their powers add, not their amplitudes, so only
 * equal power keeps the sum as loud as one copy. Linear ramps would dip about
 * 3 dB at the middle of each overlap.
 */
export function bedGains(position: number, duration: number): number {
  const rise = rampOf(position)
  const fall = rampOf(position - (duration - CROWD_CROSSFADE_SECONDS))
  if (rise <= 0 || fall >= 1) return 0
  return Math.sin((rise * Math.PI) / 2) * Math.cos((fall * Math.PI) / 2)
}

/**
 * When a copy of the idle crowd's file of `duration` seconds has the next
 * start, from its beginning: CROWD_CROSSFADE_SECONDS before its end.
 */
export function nextStartsAt(duration: number): number {
  return duration - CROWD_CROSSFADE_SECONDS
}

/** Each cheer's gain: a bigger play is louder. */
export const CHEER_GAIN: Record<CheerSize, number> = {
  small: 0.55,
  medium: 0.7,
  large: 0.85,
  huge: 1
}

/** The plays the crowd cheers, by the size of the cheer. */
const CHEERS: Record<string, CheerSize> = {
  strikeout: 'small',
  strike_out: 'small',
  single: 'small',
  double: 'medium',
  double_play: 'medium',
  grounded_into_double_play: 'medium',
  strikeout_double_play: 'medium',
  sac_fly_double_play: 'medium',
  sac_bunt_double_play: 'medium',
  cs_double_play: 'medium',
  runner_double_play: 'medium',
  triple: 'large',
  triple_play: 'large',
  grounded_into_triple_play: 'large',
  strikeout_triple_play: 'large',
  home_run: 'huge'
}

/**
 * The cheer a play's Gumbo event type raises: a strikeout or a single
 * small, a double or a double play medium, a triple or a triple play
 * large, a home run huge; anything else none.
 */
export function cheerOf(eventType: string | undefined): CheerSize | null {
  return eventType != null && Object.hasOwn(CHEERS, eventType)
    ? CHEERS[eventType]
    : null
}

/**
 * The cheer for a step just shown, when it completed its play; else null.
 * Either team's play cheers alike: the crowd is the whole park's.
 */
export function cheerForStep(
  session: GameState,
  step: ReplayStep
): CheerSize | null {
  // A play not yet begun has no entry.
  const play = session.liveData.plays.allPlays.at(step.atBatIndex)
  return play?.about.isComplete === true ? cheerOf(play.result.eventType) : null
}
