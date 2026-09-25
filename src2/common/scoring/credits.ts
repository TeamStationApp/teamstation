import type { ErrorKind } from './actions'
import { playerRef } from './lineup'
import {
  type GamePlay,
  type GameState,
  POSITIONS,
  type RunnerCredit
} from './state'

/**
 * Who gets credit for what. Fielding credits follow the official scoring
 * rules: on an out, everyone who handled the ball before the fielder who made
 * the putout earns one assist, once each however many times he touched it; the
 * fielder who made the putout earns it. A fielder who throws and then takes
 * the return throw earns both. The fielder who first handled a ball that fell
 * for a hit, or that the batter reached on, is credited with fielding it.
 */

function positionOf(state: GameState, id: number): string {
  return (
    POSITIONS.find(
      position => state.liveData.linescore.defense[position]?.id === id
    ) ?? ''
  )
}

function credit(
  state: GameState,
  id: number,
  kind: RunnerCredit['credit']
): RunnerCredit {
  return {
    player: playerRef(state, id),
    credit: kind,
    position: positionOf(state, id)
  }
}

/** The assists and the putout for one out, from the fielders in order. */
export function outCredits(
  state: GameState,
  fielders: readonly number[]
): RunnerCredit[] {
  const putout = fielders.at(-1)
  if (putout == null) return []
  const assists = [...new Set(fielders.slice(0, -1))]
  return [
    ...assists.map(id => credit(state, id, 'f_assist')),
    credit(state, putout, 'f_putout')
  ]
}

/** The fielder who first handled a ball the batter reached on. */
export function fieldedCredit(state: GameState, fielder: number): RunnerCredit {
  return credit(state, fielder, 'f_fielded_ball')
}

export function errorCredit(
  state: GameState,
  fielder: number,
  kind: ErrorKind = 'fielding'
): RunnerCredit {
  return credit(
    state,
    fielder,
    kind === 'throwing' ? 'f_throwing_error' : 'f_fielding_error'
  )
}

/**
 * Whether a run on this play is batted in. Nobody drives in a run that scored
 * on a balk, on an error, or on a play the defence could have ended with a
 * force for the third out; those are taken back when the out is made.
 */
export function earnsRbi(outcome: string | undefined): boolean {
  return (
    outcome !== 'Balk' &&
    outcome !== 'Error' &&
    outcome !== 'Dropped Third Strike'
  )
}

/** Reasons a runner scores that nobody batted in, whatever the play. */
const UNEARNED_ADVANCE = new Set([
  'Wild Pitch',
  'Passed Ball',
  'Throwing Error',
  'Fielding Error',
  'Balk'
])

/**
 * A runner the scorer moves home while the play is still open — tagging up on
 * a caught fly, taking an extra base on the hit — was batted in, unless the
 * play itself earns none or he scored on the defence's mistake.
 */
export function advanceEarnsRbi(
  outcome: string | undefined,
  reason: string
): boolean {
  return outcome != null && earnsRbi(outcome) && !UNEARNED_ADVANCE.has(reason)
}

const PLATE_APPEARANCE = new Set([
  'single',
  'double',
  'triple',
  'home_run',
  'field_error',
  'fielders_choice',
  'field_out',
  'other_out',
  'grounded_into_double_play',
  'triple_play',
  'strikeout',
  'strikeout_double_play',
  'walk',
  'intent_walk',
  'hit_by_pitch',
  'catcher_interference',
  'manual_placement',
  'sac_fly',
  'sac_fly_double_play',
  'sac_bunt'
])
/** A plate appearance that does not count as an at-bat. */
const NOT_AT_BAT = new Set([
  'walk',
  'intent_walk',
  'hit_by_pitch',
  'catcher_interference',
  'manual_placement',
  'sac_fly',
  'sac_fly_double_play',
  'sac_bunt'
])
const HITS = new Set(['single', 'double', 'triple', 'home_run'])
const STRIKEOUTS = new Set(['strikeout', 'strikeout_double_play'])
const WALKS = new Set(['walk', 'intent_walk'])

export interface BattingLine {
  pa: number
  ab: number
  r: number
  h: number
  rbi: number
  bb: number
  k: number
  hbp: number
}
export interface PitchingLine {
  pitches: number
  outs: number
  h: number
  r: number
  bb: number
  k: number
}

function blankBatting(): BattingLine {
  return { pa: 0, ab: 0, r: 0, h: 0, rbi: 0, bb: 0, k: 0, hbp: 0 }
}
function blankPitching(): PitchingLine {
  return { pitches: 0, outs: 0, h: 0, r: 0, bb: 0, k: 0 }
}

/** Each batter's line and each pitcher's line, worked out from the plays. */
export function statLines(plays: readonly GamePlay[]): {
  batting: Record<number, BattingLine>
  pitching: Record<number, PitchingLine>
} {
  const batting: Record<number, BattingLine> = {}
  const pitching: Record<number, PitchingLine> = {}
  const bat = (id: number): BattingLine => (batting[id] ??= blankBatting())
  const pitch = (id: number): PitchingLine => (pitching[id] ??= blankPitching())
  for (const play of plays) {
    const type = play.result.eventType
    const batter = play.matchup.batter.id
    const pitcher = pitch(play.matchup.pitcher.id)
    pitcher.pitches += play.playEvents.filter(event => event.isPitch).length
    for (const runner of play.runners) {
      if (runner.movement.isOut) pitcher.outs++
      if (runner.movement.runScored === true && !runner.movement.isOut) {
        bat(runner.details.runner.id).r++
        pitcher.r++
      }
    }
    if (!play.about.isComplete || !PLATE_APPEARANCE.has(type)) continue
    const line = bat(batter)
    line.pa++
    if (!NOT_AT_BAT.has(type)) line.ab++
    if (HITS.has(type)) {
      line.h++
      pitcher.h++
    }
    if (STRIKEOUTS.has(type)) {
      line.k++
      pitcher.k++
    }
    if (WALKS.has(type)) {
      line.bb++
      pitcher.bb++
    }
    if (type === 'hit_by_pitch') line.hbp++
    line.rbi += play.result.rbi
  }
  return { batting, pitching }
}
