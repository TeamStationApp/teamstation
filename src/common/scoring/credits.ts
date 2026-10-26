import type { ErrorKind } from './actions'
import { storedEventType } from './document'
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

/** The position a fielder is playing, or '' when he is not in the field. */
export function positionOf(state: GameState, id: number): string {
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

// Keyed by the event type a play is stored with (`storedEventType`), so a
// batter's own "Batter Out — Other" is a plate appearance and a runner's third
// out between pitches is not.
const PLATE_APPEARANCE = new Set([
  'single',
  'double',
  'triple',
  'home_run',
  'field_error',
  'fielders_choice',
  'fielders_choice_out',
  'force_out',
  'field_out',
  'ts_batter_out',
  'double_play',
  'grounded_into_double_play',
  'grounded_into_triple_play',
  'triple_play',
  'strikeout',
  'strikeout_double_play',
  'strikeout_triple_play',
  'walk',
  'intent_walk',
  'hit_by_pitch',
  'catcher_interf',
  'ts_manual_placement',
  'sac_fly',
  'sac_fly_double_play',
  'sac_bunt',
  'sac_bunt_double_play'
])
/** A plate appearance that does not count as an at-bat. */
const NOT_AT_BAT = new Set([
  'walk',
  'intent_walk',
  'hit_by_pitch',
  'catcher_interf',
  'ts_manual_placement',
  'sac_fly',
  'sac_fly_double_play',
  'sac_bunt',
  'sac_bunt_double_play'
])
const HITS = new Set(['single', 'double', 'triple', 'home_run'])
const STRIKEOUTS = new Set([
  'strikeout',
  'strikeout_double_play',
  'strikeout_triple_play'
])
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

/**
 * What a play of a stored event type counts on the batter's line: a plate
 * appearance, an at-bat, a strikeout.
 */
export function battingCounts(type: string): {
  pa: boolean
  ab: boolean
  k: boolean
} {
  const pa = PLATE_APPEARANCE.has(type)
  return { pa, ab: pa && !NOT_AT_BAT.has(type), k: STRIKEOUTS.has(type) }
}

/**
 * Whom a play's strikeout is charged to (9.15(b)): a batter who left with
 * two strikes, when the pinch hitter who replaced him struck out. With more
 * than one pinch hitter, the man the first sent in at two strikes replaced.
 * Read from the play's offensive substitutions for its batter, each with the
 * count he came in at; otherwise the batter.
 */
export function strikeoutBatter(play: {
  matchup: { batter: { id: number } }
  playEvents: ReadonlyArray<{
    details?: { code?: string }
    player?: { id?: number }
    replacedPlayer?: { id?: number } | null
    count?: { strikes?: number }
  }>
}): number {
  let up = play.matchup.batter.id
  let charged = up
  for (const event of [...play.playEvents].reverse()) {
    const replaced = event.replacedPlayer?.id
    const playerId = event.player?.id
    if (
      event.details?.code !== 'offensive_substitution' ||
      playerId !== up ||
      replaced == null
    )
      continue
    if (event.count?.strikes === 2) charged = replaced
    up = replaced
  }
  return charged
}

/**
 * The hits and at-bats one finished plate appearance adds, and the batter
 * they count for. Nothing when the play is not a plate appearance, or names
 * no batter. A strikeout is charged the way `statLines` charges it.
 */
export function finishedPlateLine(play: {
  result: { eventType: string }
  source?: { teamstation?: { outcome?: string } }
  matchup?: { batter?: { id: number } | null } | null
  playEvents?: GamePlay['playEvents']
}): { id: number; hits: number; atBats: number } | undefined {
  const batter = play.matchup?.batter
  if (batter == null) return undefined
  const type = storedEventType(
    play.result.eventType,
    play.source?.teamstation?.outcome
  )
  const counts = battingCounts(type)
  if (!counts.pa) return undefined
  const id = counts.k
    ? strikeoutBatter({
        matchup: { batter },
        playEvents: play.playEvents ?? []
      })
    : batter.id
  return { id, hits: HITS.has(type) ? 1 : 0, atBats: counts.ab ? 1 : 0 }
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
    const type = storedEventType(
      play.result.eventType,
      play.source.teamstation.outcome
    )
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
    const counts = battingCounts(type)
    if (!play.about.isComplete || !counts.pa) continue
    const line = bat(counts.k ? strikeoutBatter(play) : batter)
    line.pa++
    if (counts.ab) line.ab++
    if (HITS.has(type)) {
      line.h++
      pitcher.h++
    }
    if (counts.k) {
      line.k++
      pitcher.k++
    }
    if (WALKS.has(type)) {
      line.bb++
      pitcher.bb++
    }
    if (type === 'hit_by_pitch') line.hbp++
    if (play.result.rbi > 0) bat(batter).rbi += play.result.rbi
  }
  return { batting, pitching }
}
