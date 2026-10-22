import { statLines } from '../scoring/credits'
import type { GamePlay, GameState, Side } from '../scoring/state'
import { inningsPitched } from '../statExtras'
import { namesOf } from './replayNames'

/**
 * The box score of a game as it stands at one moment of a replay: each
 * side's batters in batting order, a substitute right after the player they
 * replaced, and its pitchers in the order they took the mound. Counting
 * stats come from the engine's `statLines`; a run is charged to the runner's
 * responsible pitcher, earned or not, as the stats builder charges it.
 */

export interface ReplayBattingLine {
  id: number
  name: string
  ab: number
  r: number
  h: number
  rbi: number
  bb: number
  k: number
  /** A substitute, listed under the slot they entered. */
  sub: boolean
  /** At the plate now. */
  current: boolean
}

export interface ReplayPitchingLine {
  id: number
  name: string
  /** Outs recorded; innings pitched are `outs / 3`, written `ip`. */
  outs: number
  ip: string
  h: number
  r: number
  er: number
  bb: number
  k: number
  pc: number
  /** On the mound now. */
  current: boolean
}

export interface ReplaySide {
  name: string
  batting: ReplayBattingLine[]
  pitching: ReplayPitchingLine[]
  /** Runs per inning, from the first; null for an inning not shown. */
  innings: Array<number | null>
  runs: number
  hits: number
  errors: number
}

export interface ReplayBoxScore {
  away: ReplaySide
  home: ReplaySide
  /**
   * Where TeamStation's own scoring begins when earlier plays were imported:
   * the lines count only the scored plays, and the earlier innings are blank.
   */
  from: { inning: number; half: 'top' | 'bottom' } | null
}

function playsOf(state: GameState): GamePlay[] {
  const current = state.liveData.plays.currentPlay
  return current == null
    ? state.liveData.plays.allPlays
    : [...state.liveData.plays.allPlays, current]
}

/**
 * Each slot's players, in the order they held it. A player takes a slot in
 * the change that brings him into the game with an order code such as `601`
 * (the first to come in at sixth). A player already in the game who moves to
 * another position, or to the mound, keeps his place, and so does the man
 * whose position he took.
 */
function slots(state: GameState, side: Side): number[][] {
  const order = state.liveData.boxscore.teams[side].battingOrder
  const chains = order.map(id => [id])
  const changes = playsOf(state)
    .flatMap(play => play.playEvents)
    .filter(event => event.isSubstitution === true)
  const entries = changes.filter(
    (event, index) =>
      Number(event.battingOrder) % 100 > 0 &&
      changes.findIndex(other => other.player.id === event.player.id) === index
  )
  for (const event of [...entries].reverse()) {
    const replaced = event.replacedPlayer?.id
    const chain = chains[Math.floor(Number(event.battingOrder) / 100) - 1]
    if (
      replaced == null ||
      chain?.[0] !== event.player.id ||
      order.includes(replaced) ||
      chains.some(item => item.includes(replaced))
    )
      continue
    chain.unshift(replaced)
  }
  return chains
}

/** The side's pitchers, first to take the mound first. */
function pitchers(state: GameState, side: Side): number[] {
  const team = state.gameData.teams[side].id
  const plays = playsOf(state)
  const changes = (play: GamePlay): GamePlay['playEvents'] =>
    play.playEvents.filter(
      event => event.isSubstitution === true && event.position === 'P'
    )
  // A change's replaced player is whoever left the slot, who may never have
  // pitched (a pinch hitter): only someone who did pitch is listed.
  const pitched = new Set<number>()
  for (const play of plays) {
    pitched.add(play.matchup.pitcher.id)
    for (const change of changes(play)) pitched.add(change.player.id)
  }
  const mound = state.liveData.boxscore.teams[side].defense.P
  if (mound != null) pitched.add(mound)
  const order: number[] = []
  const add = (id: number | undefined): void => {
    if (id == null || order.includes(id) || !pitched.has(id)) return
    if (state.gameData.players[id]?.teamId !== team) return
    order.push(id)
  }
  for (const play of plays) {
    const made = changes(play)
    add(made[0]?.replacedPlayer?.id)
    for (const change of made) add(change.player.id)
    add(play.matchup.pitcher.id)
  }
  add(mound ?? undefined)
  return order
}

function runsByInning(
  state: GameState,
  side: Side,
  from: ReplayBoxScore['from']
): Array<number | null> {
  const half = side === 'away' ? 'top' : 'bottom'
  const innings: Array<number | null> = []
  const linescore = state.liveData.linescore
  const reached = linescore.currentInning
  const played = new Set(
    playsOf(state)
      .filter(
        play => play.about.halfInning === half && play.playEvents.length > 0
      )
      .map(play => play.about.inning)
  )
  for (let inning = 1; inning <= reached; inning++) {
    const now =
      !state.final &&
      inning === reached &&
      linescore.isTopInning === (half === 'top')
    const started = inning < reached || played.has(inning) || now
    const hidden =
      from != null &&
      (inning < from.inning ||
        (inning === from.inning && half === 'top' && from.half === 'bottom'))
    innings.push(started && !hidden ? 0 : null)
  }
  for (const play of playsOf(state)) {
    if (play.about.halfInning !== half) continue
    const index = play.about.inning - 1
    if (innings[index] == null) continue
    for (const runner of play.runners)
      if (runner.movement.runScored === true && !runner.movement.isOut)
        innings[index] = (innings[index] ?? 0) + 1
  }
  return innings
}

export function replayBoxScore(
  state: GameState,
  from: ReplayBoxScore['from'] = null
): ReplayBoxScore {
  const plays = playsOf(state)
  const lines = statLines(plays)
  const names = namesOf(state)
  const runs = new Map<number, { r: number; er: number }>()
  for (const play of plays)
    for (const runner of play.runners) {
      if (runner.movement.runScored !== true || runner.movement.isOut) continue
      const id =
        runner.details.responsiblePitcher?.id ?? play.matchup.pitcher.id
      const line = runs.get(id) ?? { r: 0, er: 0 }
      line.r++
      if (runner.details.earned === true) line.er++
      runs.set(id, line)
    }
  const offense = state.liveData.linescore.offense.batter?.id
  const linescore = state.liveData.linescore
  const side = (which: Side): ReplaySide => {
    const team = state.liveData.boxscore.teams[which]
    const atBat = linescore.isTopInning === (which === 'away')
    const batting = slots(state, which).flatMap(chain =>
      chain.map((id, index): ReplayBattingLine => {
        const line = lines.batting[id]
        return {
          id,
          name: names.get(id) ?? '',
          ab: line?.ab ?? 0,
          r: line?.r ?? 0,
          h: line?.h ?? 0,
          rbi: line?.rbi ?? 0,
          bb: line?.bb ?? 0,
          k: line?.k ?? 0,
          sub: index > 0,
          current: atBat && !state.final && id === offense
        }
      })
    )
    const mound = linescore.defense.P?.id
    const pitching = pitchers(state, which).map((id): ReplayPitchingLine => {
      const line = lines.pitching[id]
      const charged = runs.get(id)
      const outs = line?.outs ?? 0
      return {
        id,
        name: names.get(id) ?? '',
        outs,
        ip: inningsPitched(outs),
        h: line?.h ?? 0,
        r: charged?.r ?? 0,
        er: charged?.er ?? 0,
        bb: line?.bb ?? 0,
        k: line?.k ?? 0,
        pc: team.pitchCounts[id] ?? 0,
        current: !atBat && !state.final && id === mound
      }
    })
    const totals = linescore.teams[which]
    return {
      name: state.gameData.teams[which].name,
      batting,
      pitching,
      innings: runsByInning(state, which, from),
      runs: totals.runs,
      hits: totals.hits,
      errors: totals.errors
    }
  }
  return { away: side('away'), home: side('home'), from }
}

/** Where a timeline's own scoring begins, when earlier plays were imported. */
export function scoredFrom(
  start: GameState,
  derived: number
): ReplayBoxScore['from'] {
  if (derived === 0) return null
  const linescore = start.liveData.linescore
  return {
    inning: linescore.currentInning,
    half: linescore.isTopInning ? 'top' : 'bottom'
  }
}
