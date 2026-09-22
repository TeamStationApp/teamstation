import type { ScoreboardState } from './scoreboardModel'
export type PitchKind = 'ball' | 'called' | 'swing' | 'foul' | 'play'
/** Local count keeping only; batted-ball outcomes and runner scoring stay manual. */
export function recordPitch(
  state: ScoreboardState,
  kind: PitchKind
): ScoreboardState {
  const next = { ...state, pitchCount: state.pitchCount + 1 }
  if (kind === 'ball') {
    if (next.balls === 3) {
      next.balls = 0
      next.strikes = 0
    } else next.balls++
  } else if (kind === 'called' || kind === 'swing') {
    if (next.strikes === 2) {
      next.balls = 0
      next.strikes = 0
      next.outs = (next.outs + 1) % 3
      next.batterAtBats = (next.batterAtBats ?? 0) + 1
    } else next.strikes++
  } else if (kind === 'foul') next.strikes = Math.min(2, next.strikes + 1)
  return next
}
