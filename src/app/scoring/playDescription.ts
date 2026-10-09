import {
  type BallInPlayAction,
  type Destination,
  type Direction,
  type ScoringAction,
  shortName
} from '../../common/scoring/actions'
import { trajectoryOf } from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import {
  type GameState,
  type Position,
  POSITIONS
} from '../../common/scoring/state'
import type { HistoryEntry } from './scoringTypes'

/**
 * A play in two lines, the same for a tap and a sentence: what happened to the
 * batter — or, with no batter's event, the steal, the move, the pitches — and
 * then what the fielders and the other runners did.
 */
export interface PlayDescription {
  primary: string
  secondary?: string
}

const BASE_WORDS: Record<Destination, string> = {
  batter: 'the plate',
  '1B': 'first',
  '2B': 'second',
  '3B': 'third',
  home: 'home'
}
const DIRECTIONS: Record<Position, string> = {
  P: 'the pitcher',
  C: 'the catcher',
  '1B': 'first',
  '2B': 'second',
  SS: 'short',
  '3B': 'third',
  LF: 'left',
  CF: 'center',
  RF: 'right'
}
const DIRECTION_WORDS: Record<Direction, string> = {
  left: 'left',
  left_center: 'left center',
  center: 'center',
  right_center: 'right center',
  right: 'right'
}
const TRAJECTORIES: Record<string, string> = {
  ground_ball: 'ground ball',
  chopper: 'chopper',
  line_drive: 'line drive',
  fly_ball: 'fly ball',
  popup: 'pop-up'
}
const HITS: Record<string, string> = {
  single: 'single',
  double: 'double',
  triple: 'triple',
  home_run: 'home run'
}
const PITCHES: Record<string, string> = {
  B: 'ball',
  C: 'called strike',
  S: 'swinging strike',
  F: 'foul',
  T: 'foul tip',
  L: 'foul bunt'
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Names and positions as the game stood when the play began. */
class Words {
  constructor(private readonly game: GameState) {}

  name(id: number): string {
    const player = this.game.gameData.players[id]
    return player == null ? `Player ${id}` : shortName(player)
  }

  position(id: number): Position | undefined {
    const defense = this.game.liveData.linescore.defense
    return POSITIONS.find(position => defense[position]?.id === id)
  }

  /** "Noah D. (SS)", the way a credit reads. */
  fielder(id: number): string {
    const position = this.position(id)
    return position == null ? this.name(id) : `${this.name(id)} (${position})`
  }

  /** "Noah D. (SS) to Sam P. (1B)". */
  chain(fielders: readonly number[] | undefined): string | undefined {
    if (fielders == null || fielders.length === 0) return undefined
    return fielders.map(id => this.fielder(id)).join(' to ')
  }

  direction(fielder: number | undefined): string | undefined {
    const position = fielder == null ? undefined : this.position(fielder)
    return position == null ? undefined : DIRECTIONS[position]
  }

  batter(): number | undefined {
    return this.game.liveData.plays.currentPlay?.matchup.batter.id
  }
}

/** The pitches of the edit as a scorer would read them. */
function pitchWords(
  pitches: ReadonlyArray<Extract<ScoringAction, { type: 'pitch' }>>
): string {
  const words = pitches.map(pitch => PITCHES[pitch.call])
  return capital(words.join(', '))
}

/**
 * The batter's own event, when the pitches alone end his turn: ball four or
 * strike three, counted from the game before the edit.
 */
function pitchEnding(
  count: { balls: number; strikes: number },
  pitches: ReadonlyArray<Extract<ScoringAction, { type: 'pitch' }>>
): 'walks' | 'strikes out swinging' | 'strikes out looking' | undefined {
  let { balls, strikes } = count
  for (const pitch of pitches) {
    if (pitch.call === 'B') {
      balls++
      if (balls === 4) return 'walks'
    } else if (pitch.call === 'C' || pitch.call === 'S' || pitch.call === 'T') {
      strikes++
      if (strikes === 3)
        return pitch.call === 'C'
          ? 'strikes out looking'
          : 'strikes out swinging'
    } else if ((pitch.call === 'F' && strikes < 2) || pitch.call === 'L') {
      strikes = Math.min(3, strikes + 1)
      if (strikes === 3) return 'strikes out swinging'
    }
  }
  return undefined
}

/** Runners the edit moved or scored, as the bases changed. */
function runnerWords(
  words: Words,
  before: GameState,
  after: GameState,
  skip: ReadonlySet<number>
): string[] {
  const bases = (game: GameState): Array<number | undefined> => {
    const offense = game.liveData.linescore.offense
    return [offense.first?.id, offense.second?.id, offense.third?.id]
  }
  const was = bases(before)
  const now = bases(after)
  const runs =
    after.liveData.linescore.teams.away.runs +
    after.liveData.linescore.teams.home.runs -
    before.liveData.linescore.teams.away.runs -
    before.liveData.linescore.teams.home.runs
  const lines: string[] = []
  let scored = 0
  // Lead runner first.
  for (let index = 2; index >= 0; index--) {
    const id = was[index]
    if (id == null || skip.has(id)) continue
    const at = now.indexOf(id)
    if (at === index) continue
    if (at >= 0)
      lines.push(
        `${words.name(id)} to ${BASE_WORDS[(['1B', '2B', '3B'] as const)[at]]}`
      )
    else if (scored < runs) {
      lines.push(`${words.name(id)} scores`)
      scored++
    }
  }
  return lines
}

/**
 * The two lines for one edit. `before` is the game the actions were applied
 * to, `after` the game they made.
 */
export function describePlay(
  before: GameState,
  actions: readonly ScoringAction[],
  after: GameState
): PlayDescription | undefined {
  if (actions.length === 0) return undefined
  const words = new Words(before)
  // The batter of the play these actions open: after a decided play the
  // first of them brings the next batter up.
  const batter =
    applyAction(before, actions[0]).state.liveData.plays.currentPlay?.matchup
      .batter.id ?? words.batter()
  const pitches = actions.filter(
    (action): action is Extract<ScoringAction, { type: 'pitch' }> =>
      action.type === 'pitch'
  )
  // A tapped ball in play is the swing and then its flight: one ball.
  const inPlays = actions.filter(
    (action): action is BallInPlayAction => action.type === 'ballInPlay'
  )
  const inPlay: BallInPlayAction | undefined =
    inPlays.length === 0 ? undefined : Object.assign({}, ...inPlays)
  // A tap gives the angle, a sentence the trajectory; they read alike.
  const flight =
    inPlay?.trajectory ??
    (inPlay?.launchAngle == null ? undefined : trajectoryOf(inPlay.launchAngle))
  const result = actions.find(action => action.type === 'result')
  const secondary: string[] = []
  const mentioned = new Set<number>()
  let primary: string | undefined

  // Outs and credits on runners other than the batter.
  const runnerOuts = actions.filter(
    (action): action is Extract<ScoringAction, { type: 'runnerMovement' }> =>
      action.type === 'runnerMovement' &&
      action.out === true &&
      action.runner !== batter
  )
  const batterOut = actions.find(
    (action): action is Extract<ScoringAction, { type: 'runnerMovement' }> =>
      action.type === 'runnerMovement' &&
      action.out === true &&
      action.runner === batter
  )
  const error = actions.find(action => action.type === 'fieldingPlay')

  if (result != null && batter != null) {
    const name = words.name(batter)
    const trajectory =
      inPlay?.contact === 'bunt'
        ? 'bunt'
        : flight == null
          ? undefined
          : TRAJECTORIES[flight]
    const fielder = inPlay?.fielder
    const direction =
      inPlay?.direction != null
        ? DIRECTION_WORDS[inPlay.direction]
        : words.direction(fielder)
    const to = direction == null ? '' : ` to ${direction}`
    const hit = HITS[result.eventType]
    if (hit != null) {
      primary = `${name} ${trajectory == null ? '' : `${trajectory} `}${hit}${to}`
      // Thrown out stretching it.
      if (batterOut != null) {
        const chain = words.chain(batterOut.fielders)
        secondary.push(
          `out at ${BASE_WORDS[batterOut.to]}${chain == null ? '' : `, ${chain}`}`
        )
      }
    } else if (result.eventType === 'field_out') {
      if (result.outBy === 'catch' || result.foulCaught === true) {
        const verb =
          result.foulCaught === true
            ? 'fouls out'
            : flight === 'popup'
              ? 'pops out'
              : flight === 'line_drive'
                ? 'lines out'
                : 'flies out'
        primary = `${name} ${verb}${to}`
        if (fielder != null)
          secondary.push(`caught by ${words.fielder(fielder)}`)
      } else if (result.outBy === 'interference')
        primary = `${name} out on interference`
      else {
        primary = `${name} ${trajectory === 'bunt' ? 'bunt out' : trajectory === 'line drive' ? 'lines out' : 'ground out'}`
        const chain = words.chain(batterOut?.fielders)
        if (chain != null) secondary.push(chain)
      }
    } else if (result.eventType === 'field_error') {
      primary = `${name} reaches on an error`
      if (error?.type === 'fieldingPlay' && error.error != null)
        secondary.push(`error by ${words.fielder(error.error)}`)
    } else if (result.eventType === 'fielders_choice')
      primary = `${name} reaches on a fielder's choice`
    else if (result.eventType === 'hit_by_pitch')
      primary = `${name} hit by pitch`
    else if (result.eventType === 'intent_walk')
      primary = `${name} intentionally walked`
    else if (result.eventType === 'catcher_interference')
      primary = `${name} reaches on catcher's interference`
    else if (result.eventType === 'strikeout') {
      primary = `${name} strikes out, dropped third strike`
      const reached = actions.some(
        action =>
          action.type === 'runnerMovement' &&
          action.runner === batter &&
          action.out !== true
      )
      secondary.push(
        batterOut != null ? 'out at first' : reached ? 'safe at first' : ''
      )
    } else if (result.eventType === 'manual_placement')
      primary = `${name} placed on ${result.base == null ? 'base' : BASE_WORDS[result.base]}`
    else primary = `${name} out`
    if (pitches.length > 0)
      secondary.unshift(`after ${pitchWords(pitches).toLowerCase()}`)
  }

  for (const out of runnerOuts) {
    mentioned.add(out.runner)
    const chain = words.chain(out.fielders)
    secondary.push(
      `${words.name(out.runner)} out at ${BASE_WORDS[out.to]}${chain == null ? '' : `, ${chain}`}`
    )
  }

  if (primary == null) {
    const running = actions.find(action => action.type === 'baseRunning')
    const battery = actions.find(action => action.type === 'batteryEvent')
    const lineup = actions.find(action => action.type === 'lineup')
    const flow = actions.find(action => action.type === 'gameFlow')
    // A walk or strikeout the pitches came to leads, with the running after.
    const count =
      batter === words.batter()
        ? before.liveData.linescore
        : { balls: 0, strikes: 0 }
    const pitchEnd =
      batter == null || pitches.length === 0
        ? undefined
        : pitchEnding(count, pitches)
    if (running?.type === 'baseRunning') {
      const told = (
        action: Extract<ScoringAction, { type: 'baseRunning' }>
      ): string => {
        const base = action.to == null ? 'a base' : BASE_WORDS[action.to]
        const name = words.name(action.runner)
        return action.kind === 'steal'
          ? `${name} steals ${base}`
          : action.kind === 'caught_stealing'
            ? `${name} caught stealing ${base}`
            : action.kind === 'pickoff'
              ? `${name} picked off`
              : action.kind === 'pickoff_safe'
                ? `${name} safe on a pickoff throw`
                : `${name} takes ${base} on defensive indifference`
      }
      mentioned.add(running.runner)
      const chain = words.chain(running.fielders)
      if (pitchEnd != null && batter != null) {
        primary = `${words.name(batter)} ${pitchEnd}`
        secondary.push(`${told(running)}${chain == null ? '' : `, ${chain}`}`)
      } else {
        primary = told(running)
        if (chain != null) secondary.push(chain)
      }
      // A double steal's other runners, out or safe.
      for (const other of actions)
        if (other !== running && other.type === 'baseRunning') {
          mentioned.add(other.runner)
          const otherChain = words.chain(other.fielders)
          secondary.push(
            `${told(other)}${otherChain == null ? '' : `, ${otherChain}`}`
          )
        }
    } else if (battery?.type === 'batteryEvent') {
      const event = capital(battery.kind.replace('_', ' '))
      if (pitchEnd != null && batter != null) {
        primary = `${words.name(batter)} ${pitchEnd}`
        secondary.push(event)
      } else {
        primary = event
        if (pitches.length > 0)
          secondary.push(`on ${pitchWords(pitches).toLowerCase()}`)
      }
    } else if (pitches.length > 0) {
      // A new batter's count starts at nothing.
      const count =
        batter === words.batter()
          ? before.liveData.linescore
          : { balls: 0, strikes: 0 }
      const ending = batter == null ? undefined : pitchEnding(count, pitches)
      if (ending != null && batter != null) {
        primary = `${words.name(batter)} ${ending}`
        if (pitches.length > 1)
          secondary.push(`on ${pitchWords(pitches).toLowerCase()}`)
      } else primary = pitchWords(pitches)
    } else if (lineup?.type === 'lineup') {
      const player =
        lineup.player == null ? undefined : words.name(lineup.player)
      const replaced =
        lineup.replaces == null ? undefined : words.name(lineup.replaces)
      primary =
        lineup.kind === 'substitute' && player != null
          ? `${player} in${replaced == null ? '' : ` for ${replaced}`}${lineup.position == null ? '' : ` at ${lineup.position}`}`
          : lineup.kind === 'pinchRunner' && player != null
            ? `${player} runs${replaced == null ? '' : ` for ${replaced}`}`
            : lineup.kind === 'batterSide'
              ? `${batter == null ? 'The batter' : words.name(batter)} bats ${lineup.batSide === 'L' ? 'left' : 'right'}`
              : lineup.kind === 'position' &&
                  player != null &&
                  lineup.position != null
                ? `${player} to ${lineup.position}`
                : lineup.kind === 'battingOrder'
                  ? 'Batting order changed'
                  : 'Roster changed'
    } else if (flow?.type === 'gameFlow') {
      primary =
        flow.kind === 'endHalf'
          ? 'End of the half'
          : flow.kind === 'endGame'
            ? 'Game over'
            : flow.kind === 'override'
              ? 'Game corrected'
              : flow.kind === 'placeRunner'
                ? 'Runner placed'
                : 'Play closed'
    } else if (error?.type === 'fieldingPlay' && error.error != null)
      primary = `Error charged to ${words.fielder(error.error)}`
    else {
      const move = actions.find(action => action.type === 'runnerMovement')
      if (move?.type === 'runnerMovement') {
        mentioned.add(move.runner)
        primary =
          move.out === true
            ? `${words.name(move.runner)} out at ${BASE_WORDS[move.to]}`
            : move.to === 'home'
              ? `${words.name(move.runner)} scores`
              : `${words.name(move.runner)} to ${BASE_WORDS[move.to]}`
        secondary.splice(0, secondary.length)
      }
    }
  }

  const skip = new Set([...mentioned, ...(batter == null ? [] : [batter])])
  secondary.push(...runnerWords(words, before, after, skip))
  const rest = secondary.filter(line => line !== '')
  return {
    primary: primary ?? 'Play changed',
    ...(rest.length === 0 ? {} : { secondary: capital(rest.join('; ')) })
  }
}

const closesPlay = (action: ScoringAction): boolean =>
  action.type === 'gameFlow' && action.kind === 'closePlay'

/**
 * Where the log's last play lies, however many Undo entries it took to tap:
 * it ends before the step that closed it, and begins at its ball in play —
 * or, with none, at its result, or the pitch, steal or change a runner's move
 * followed — and never before the play ahead of it closed. `from` is where
 * the last entry begins; all of that entry is in the play, unless it holds
 * an earlier batter's result too.
 */
export function lastPlaySpan(
  log: readonly ScoringAction[],
  from: number
): { start: number; end: number } {
  let end = log.length
  while (end > 0 && closesPlay(log[end - 1])) end--
  let start = end
  let inPlay = false
  let result = false
  for (let index = end - 1; index >= 0; index--) {
    const action = log[index]
    if (closesPlay(action)) break
    if (action.type === 'ballInPlay') {
      inPlay = true
      start = index
      continue
    }
    if (inPlay) break
    if (
      action.type === 'result' ||
      action.type === 'runnerMovement' ||
      action.type === 'fieldingPlay'
    ) {
      result ||= action.type === 'result'
      start = index
      continue
    }
    if (!result) start = index
    break
  }
  // All of the last entry is in the play — unless an earlier batter's
  // result is in it too, as when one sentence scored two batters.
  const earlier = log
    .slice(Math.min(start, from), start)
    .some(action => action.type === 'result')
  return { start: earlier ? start : Math.min(start, from), end }
}

/**
 * The batters an Undo entry's actions are about, as runs of actions: an
 * action belongs to the plate appearance the game has open once it is
 * applied, so the next batter's first pitch or ball in play starts his run.
 * A closing belongs to the run before it.
 */
function batterRuns(
  before: GameState,
  actions: readonly ScoringAction[]
): Array<{ from: number; to: number; before: GameState; after: GameState }> {
  const runs: Array<{
    from: number
    to: number
    before: GameState
    after: GameState
  }> = []
  let state = before
  let open: number | undefined
  actions.forEach((action, index) => {
    const prior = state
    state = applyAction(state, action).state
    const last = runs.at(-1)
    const atBat = state.liveData.plays.currentPlay?.about.atBatIndex
    if (last != null && (closesPlay(action) || atBat === open)) {
      last.to = index + 1
      last.after = state
      return
    }
    open = atBat
    runs.push({ from: index, to: index + 1, before: prior, after: state })
  })
  return runs
}

/**
 * Every batter's play in the last Undo entry, oldest first — one for a
 * sentence about one batter, two for "ball four; next batter flies out".
 */
export function describeEntryPlays(
  log: readonly ScoringAction[],
  past: readonly HistoryEntry[],
  gameAt: (logLength: number) => GameState
): PlayDescription[] {
  const entry = past.at(-1)
  if (entry == null) return []
  const from = entry.logLength
  return batterRuns(gameAt(from), log.slice(from)).flatMap(run => {
    const actions = log
      .slice(from + run.from, from + run.to)
      .filter(action => !closesPlay(action))
    const described = describePlay(run.before, actions, run.after)
    return described == null ? [] : [described]
  })
}

/**
 * The last play in two lines, as the Undo control shows it. `gameAt` is the
 * game when the log was a given length — rebuilt from the screen's
 * checkpoints, or, before the first, from the game before the whole log.
 */
export function describeLastPlay(
  log: readonly ScoringAction[],
  past: readonly HistoryEntry[],
  after: GameState,
  gameAt: (logLength: number) => GameState
): PlayDescription | undefined {
  const last = past.at(-1)
  const from = last?.logLength ?? log.length
  const span = lastPlaySpan(log, from)
  // Actions about two batters — one sentence, or a reload's last play — are
  // the last batter's.
  let { start } = span
  const runs = batterRuns(gameAt(start), log.slice(start, span.end))
  if (runs.length > 1) start += runs.at(-1)!.from
  return describePlay(gameAt(start), log.slice(start, span.end), after)
}

/** Describe requested completed appearances with the same wording as Undo. */
export function describeCompletedPlays(
  log: readonly ScoringAction[],
  indexes: ReadonlySet<number>,
  gameAt: (logLength: number) => GameState
): Map<number, PlayDescription> {
  const out = new Map<number, PlayDescription>()
  if (indexes.size === 0) return out
  for (
    let index = log.length - 1;
    index >= 0 && out.size < indexes.size;
    index--
  ) {
    if (!closesPlay(log[index])) continue
    const after = gameAt(index + 1)
    const play = after.liveData.plays.allPlays.at(-1)
    if (
      play == null ||
      !indexes.has(play.about.atBatIndex) ||
      out.has(play.about.atBatIndex)
    )
      continue
    const description = describeLastPlay(
      log.slice(0, index + 1),
      [],
      after,
      gameAt
    )
    if (description != null) out.set(play.about.atBatIndex, description)
  }
  return out
}
