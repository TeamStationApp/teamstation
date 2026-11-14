import { chainOf, stateFingerprint } from '../../common/scoring/actionChain'
import {
  type BallInPlayAction,
  BASES,
  type Destination,
  type Direction,
  drawnName,
  keepsAtBat,
  type ScoringAction
} from '../../common/scoring/actions'
import { overrideOf, trajectoryOf } from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import {
  BASE_KEYS,
  type FielderRef,
  type GameState,
  isPosition,
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
/** Who plays a position, for a stand-in nobody is named for. */
const STAND_IN_WORDS: Record<Position, string> = {
  P: 'pitcher',
  C: 'catcher',
  '1B': 'first baseman',
  '2B': 'second baseman',
  SS: 'shortstop',
  '3B': 'third baseman',
  LF: 'left fielder',
  CF: 'center fielder',
  RF: 'right fielder'
}

class Words {
  constructor(private readonly game: GameState) {}

  name(id: number): string {
    const player = this.game.gameData.players[id]
    return player == null ? `Player ${id}` : drawnName(player)
  }

  position(id: FielderRef): Position | undefined {
    if (isPosition(id)) return id
    const defense = this.game.liveData.linescore.defense
    return POSITIONS.find(position => defense[position]?.id === id)
  }

  /**
   * "Noah D. (SS)", the way a credit reads; a stand-in at an empty position
   * is "the shortstop", for nobody played there.
   */
  fielder(id: FielderRef): string {
    if (isPosition(id)) return `the ${STAND_IN_WORDS[id]}`
    const position = this.position(id)
    return position == null ? this.name(id) : `${this.name(id)} (${position})`
  }

  /** "Noah D. (SS) to Sam P. (1B)". */
  chain(fielders: readonly FielderRef[] | undefined): string | undefined {
    if (fielders == null || fielders.length === 0) return undefined
    return fielders.map(id => this.fielder(id)).join(' to ')
  }

  direction(fielder: FielderRef | undefined): string | undefined {
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
 * to, `after` the game they made. Omit the secondary pitch clause when a
 * caller presents the pitch sequence separately.
 */
export function describePlay(
  before: GameState,
  actions: readonly ScoringAction[],
  after: GameState,
  includePitchClause = true
): PlayDescription | undefined {
  if (actions.length === 0) return undefined
  const words = new Words(before)
  // The batter of the play these actions open: after a decided play the
  // first of them brings the next batter up.
  const batter =
    applyAction(before, actions[0], { replay: true }).state.liveData.plays
      .currentPlay?.matchup.batter.id ?? words.batter()
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
    if (includePitchClause && pitches.length > 0)
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
    // A saved roster with a pinch runner on it is told by the runner.
    const lineup =
      actions.find(
        action => action.type === 'lineup' && action.kind === 'runner'
      ) ?? actions.find(action => action.type === 'lineup')
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
        if (includePitchClause && pitches.length > 0)
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
        if (includePitchClause && pitches.length > 1)
          secondary.push(`on ${pitchWords(pitches).toLowerCase()}`)
      } else primary = pitchWords(pitches)
    } else if (lineup?.type === 'lineup') {
      const player =
        lineup.player == null ? undefined : words.name(lineup.player)
      const replaced =
        lineup.replaces == null ? undefined : words.name(lineup.replaces)
      // A pinch runner who leaves the order runs for the man on his base.
      const ranFor =
        lineup.base == null
          ? undefined
          : before.liveData.linescore.offense[
              BASE_KEYS[BASES.indexOf(lineup.base)]
            ]?.id
      primary =
        lineup.kind === 'substitute' && player != null
          ? `${player} in${replaced == null ? '' : ` for ${replaced}`}${lineup.position == null ? '' : ` at ${lineup.position}`}`
          : lineup.kind === 'pinchRunner' && player != null
            ? `${player} runs${replaced == null ? '' : ` for ${replaced}`}`
            : lineup.kind === 'runner' && player != null
              ? `${player} runs${ranFor == null ? '' : ` for ${words.name(ranFor)}`}`
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
      const { outs: previousOuts, ...previousSetup } = overrideOf(before)
      const { outs, ...setup } = overrideOf(after)
      const onlyOutsChanged =
        previousOuts !== outs &&
        JSON.stringify(previousSetup) === JSON.stringify(setup)
      primary =
        flow.kind === 'endHalf'
          ? 'End of the half'
          : flow.kind === 'endGame'
            ? 'Game over'
            : flow.kind === 'override'
              ? onlyOutsChanged
                ? `Set outs to ${outs}`
                : 'Game corrected'
              : flow.kind === 'placeRunner'
                ? `${flow.runner == null ? 'Runner' : words.name(flow.runner)} placed${flow.base == null ? '' : ` on ${flow.base}`}`
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
interface BatterRun {
  from: number
  to: number
  before: GameState
  after: GameState
  atBatIndex: number
}

function batterRuns(
  before: GameState,
  actions: readonly ScoringAction[],
  resume?: { runs: readonly CachedRun[]; state: GameState; index: number }
): CachedRun[] {
  const runs: CachedRun[] = resume?.runs.map(run => ({ ...run })) ?? []
  let state = resume?.state ?? before
  const resumed = runs.at(-1)
  let open: number | undefined =
    resumed == null || resumed.atBatIndex < 0 ? undefined : resumed.atBatIndex
  for (let index = resume?.index ?? 0; index < actions.length; index++) {
    const action = actions[index]
    const prior = state
    state = applyAction(state, action, { replay: true }).state
    const last = runs.at(-1)
    const atBat = state.liveData.plays.currentPlay?.about.atBatIndex
    if (last != null && (closesPlay(action) || atBat === open)) {
      last.to = index + 1
      last.after = state
      continue
    }
    open = atBat
    runs.push({
      from: index,
      to: index + 1,
      before: prior,
      after: state,
      atBatIndex: atBat ?? -(index + 1)
    })
  }
  return runs
}

/** Every run with its games, as the Undo label reads them. */
function fullRuns(
  before: GameState,
  actions: readonly ScoringAction[]
): BatterRun[] {
  // With no resume point, every run is replayed and keeps both games.
  return batterRuns(before, actions) as BatterRun[]
}

/** A run as the cache keeps it: older runs without their games. */
type CachedRun = Omit<BatterRun, 'before' | 'after'> & {
  before?: GameState
  after?: GameState
}

/**
 * How many of the latest runs keep their before and after games. Each game
 * holds the whole game so far, so keeping one per run would make the cache
 * grow with the square of the game's length; a correction older than these
 * replays the log once from the opening.
 */
const RUNS_WITH_STATES = 8

export interface LogDescriptionCache {
  opening?: GameState
  openingKey?: string
  /** The prefix hash chain (`actionChain`) of the log last described. */
  chain: readonly string[]
  /** Every run's bounds; only the latest `RUNS_WITH_STATES` keep games. */
  runs?: CachedRun[]
  /** `from:to` → a span's words, null where it has none. */
  spans: Map<string, { to: number; text: string | null }>
}

export function newLogDescriptionCache(): LogDescriptionCache {
  return { chain: [], spans: new Map() }
}

/** Same object first; the fingerprint only when a reload replaced it. */
function sameOpening(cache: LogDescriptionCache, opening: GameState): boolean {
  if (cache.opening === opening) return true
  const key = stateFingerprint(opening)
  const same = key === cache.openingKey
  cache.opening = opening
  cache.openingKey = key
  return same
}

/** The cache brought up to `log`, and the batter runs it holds. */
function cachedRuns(
  opening: GameState,
  log: readonly ScoringAction[],
  authors: ReadonlyArray<string | null>,
  cache: LogDescriptionCache | undefined,
  chain: readonly string[] | undefined
): { runs: CachedRun[]; full: () => Map<number, BatterRun> } {
  let resume: { runs: CachedRun[]; state: GameState; index: number } | undefined
  if (cache != null) {
    // The chain the caller passes covers authors; so must the one built here.
    const logChain = chain ?? chainOf(log, authors)
    let common = 0
    if (sameOpening(cache, opening)) {
      const shared = Math.min(log.length, cache.chain.length - 1)
      while (
        common < shared &&
        cache.chain[common + 1] === logChain[common + 1]
      )
        common++
    }
    const kept = (cache.runs ?? []).filter(run => run.to <= common)
    // Resume after the latest kept run that still has its game.
    let at = kept.length - 1
    while (at >= 0 && kept[at].after == null) at--
    if (at >= 0)
      resume = {
        runs: kept.slice(0, at + 1),
        state: kept[at].after!,
        index: kept[at].to
      }
    for (const [key, span] of cache.spans)
      if (span.to > common) cache.spans.delete(key)
    cache.chain = logChain
  }
  const runs = batterRuns(opening, log, resume)
  if (cache != null)
    cache.runs = runs.map((run, index) =>
      index < runs.length - RUNS_WITH_STATES
        ? { from: run.from, to: run.to, atBatIndex: run.atBatIndex }
        : run
    )
  // An older run with no games, whose words are not cached, is described
  // from one replay of the whole log, made only when it is needed.
  let replayed: Map<number, BatterRun> | undefined
  const full = (): Map<number, BatterRun> =>
    (replayed ??= new Map(fullRuns(opening, log).map(run => [run.from, run])))
  return { runs, full }
}

/** The run with its games, from the cache or from one full replay. */
function withGames(
  run: CachedRun,
  full: () => Map<number, BatterRun>
): BatterRun {
  return run.before != null && run.after != null
    ? (run as BatterRun)
    : full().get(run.from)!
}

/**
 * The words for `log[from, to)`, played from `before` to `after`: the pitch
 * row, then each event before contact, then the outcome with no pitch clause.
 * Nothing for actions only lineups or closes, or that `describePlay` cannot
 * describe.
 */
function describeSpan(
  log: readonly ScoringAction[],
  from: number,
  to: number,
  before: GameState,
  after: GameState,
  readable: (game: GameState) => GameState
): string | undefined {
  const sourceActions = log.slice(from, to)
  const actions = sourceActions.filter(action => !closesPlay(action))
  if (actions.every(action => action.type === 'lineup')) return undefined
  // The pitch history has its own row. Like Undo's last-play span, begin
  // the outcome at contact, with the preceding pitches already applied.
  const outcomeStart = sourceActions.findIndex(
    action => action.type === 'ballInPlay' || action.type === 'result'
  )
  const prefix = sourceActions.slice(0, Math.max(0, outcomeStart))
  const start = prefix.filter(action => !closesPlay(action)).length
  let beforePlay = before
  const earlierEvents: string[] = []
  for (const action of prefix) {
    const next = applyAction(beforePlay, action, { replay: true }).state
    if (
      action.type !== 'pitch' &&
      action.type !== 'lineup' &&
      !closesPlay(action)
    ) {
      const earlier = describePlay(
        readable(beforePlay),
        [action],
        readable(next)
      )
      if (earlier != null)
        earlierEvents.push(
          [earlier.primary, earlier.secondary].filter(Boolean).join(', ')
        )
    }
    beforePlay = next
  }
  const description = describePlay(
    readable(beforePlay),
    actions.slice(start),
    readable(after),
    false
  )
  if (description == null) return undefined
  const pitches = actions.filter(
    (action): action is Extract<ScoringAction, { type: 'pitch' }> =>
      action.type === 'pitch'
  )
  const pitchLine = pitches.length === 0 ? '' : pitchWords(pitches)
  const playLine = [description.primary, description.secondary]
    .filter(Boolean)
    .join(', ')
  return [
    ...(pitchLine === '' || description.primary === pitchLine
      ? []
      : [pitchLine]),
    ...earlierEvents,
    playLine
  ].join('\n')
}

/** One author's consecutive actions within one batter's run. */
export interface LogSpan {
  /** The at-bat, or a negative key for actions while none is open. */
  atBatIndex: number
  from: number
  to: number
  /** The first action's place among its at-bat's actions. */
  position: number
  author: string | null
  /** The span's words, or undefined where they cannot be told. */
  text: string | undefined
}

/**
 * Each batter's run split into maximal spans with one author, each described
 * from its own before and after games. A closing joins the span before it,
 * whoever recorded it.
 */
export function describeLogSpans(
  opening: GameState,
  log: readonly ScoringAction[],
  authors: ReadonlyArray<string | null>,
  readable: (game: GameState) => GameState,
  cache?: LogDescriptionCache,
  chain?: readonly string[]
): LogSpan[] {
  const spans: LogSpan[] = []
  const positions = new Map<number, number>()
  const { runs, full } = cachedRuns(opening, log, authors, cache, chain)
  for (const run of runs) {
    // The run's games, fetched only when one of its spans needs words.
    let games: BatterRun | undefined
    let state: GameState | undefined
    let from = run.from
    const at = (index: number): GameState => {
      games ??= withGames(run, full)
      state ??= games.before
      while (from < index) {
        state = applyAction(state, log[from], { replay: true }).state
        from++
      }
      return state
    }
    let start = run.from
    for (let index = run.from; index < run.to; index++) {
      const next = index + 1
      // A game-flow event (End of the half, Game over, a placed runner, a
      // correction) is a span of its own, so its words are never folded
      // into the pitches before it.
      const flow = (action: ScoringAction | undefined): boolean =>
        action?.type === 'gameFlow' && !closesPlay(action)
      const ends =
        next === run.to ||
        flow(log[index]) ||
        flow(log[next]) ||
        (!closesPlay(log[next]) && authors[next] !== authors[start])
      if (!ends) continue
      const key = `${start}:${next}`
      let text = cache?.spans.get(key)?.text
      if (text === undefined) {
        try {
          const before = at(start)
          const after = next === run.to ? withGames(run, full).after : at(next)
          text = describeSpan(log, start, next, before, after, readable) ?? null
        } catch {
          text = undefined
        }
        if (text !== undefined) cache?.spans.set(key, { to: next, text })
      }
      const position = positions.get(run.atBatIndex) ?? 0
      positions.set(run.atBatIndex, position + (next - start))
      spans.push({
        atBatIndex: run.atBatIndex,
        from: start,
        to: next,
        position,
        author: authors[start] ?? null,
        text: text ?? undefined
      })
      start = next
    }
  }
  return spans
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
  return fullRuns(gameAt(from), log.slice(from)).flatMap(run => {
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
  const runs = fullRuns(gameAt(start), log.slice(start, span.end))
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
    const action = log[index]
    // An end of the half that keeps the at-bat saves it as a play of its own,
    // described by the actions before it: the end of the half is no part of it.
    const endedHalf = keepsAtBat(action)
    if (!closesPlay(action) && !endedHalf) continue
    const after = gameAt(index + 1)
    const play = after.liveData.plays.allPlays.at(-1)
    if (
      play == null ||
      (endedHalf &&
        after.liveData.plays.allPlays.length ===
          gameAt(index).liveData.plays.allPlays.length) ||
      !indexes.has(play.about.atBatIndex) ||
      out.has(play.about.atBatIndex)
    )
      continue
    const description = endedHalf
      ? describeKeptAtBat(log, index, gameAt)
      : describeLastPlay(log.slice(0, index + 1), [], after, gameAt)
    if (description != null) out.set(play.about.atBatIndex, description)
  }
  return out
}

/**
 * The at-bat an end of the half at `index` kept: every action taken while it
 * was the at-bat in progress, the running play it was saved as among them,
 * read against the game just before the half ended, whose bases still hold
 * the runners it left on. Which at-bat each action left in progress says
 * where it began, as no closing action does when the half before ended on a
 * third out between pitches.
 */
function describeKeptAtBat(
  log: readonly ScoringAction[],
  index: number,
  gameAt: (logLength: number) => GameState
): PlayDescription | undefined {
  const kept = gameAt(index).liveData.plays.currentPlay?.about.atBatIndex
  const atBat = (state: GameState): number | undefined =>
    state.liveData.plays.currentPlay?.about.atBatIndex
  // An action is the kept at-bat's when it was taken in it, or when it is the
  // pitch that closed the play ahead and began it, in the same half: a third
  // out between pitches begins it too, but in the half after its own.
  const its = (at: number): boolean => {
    const before = gameAt(at)
    const after = gameAt(at + 1)
    return (
      atBat(before) === kept ||
      (atBat(after) === kept &&
        before.liveData.linescore.isTopInning ===
          after.liveData.linescore.isTopInning)
    )
  }
  let start = index
  while (start > 0 && !closesPlay(log[start - 1]) && its(start - 1)) start--
  const actions = log.slice(start, index)
  // A play closed by its next pitch leaves no closePlay: the last batter's.
  const runs = fullRuns(gameAt(start), actions)
  if (runs.length > 1) start += runs.at(-1)!.from
  return describePlay(gameAt(start), log.slice(start, index), gameAt(index))
}
