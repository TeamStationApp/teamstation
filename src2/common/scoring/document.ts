import { type DescribedCredit, describePlay } from '../describePlay'
import { GAME_POSITIONS } from '../gumbo/reference'
import { eventTypeName } from '../gumboEventTypes'
import {
  asCurrentPlay,
  asGumboPlay,
  type CurrentPlay,
  type GumboPlay
} from '../gumboPlay'
import type { ScoringAction } from './actions'
import { ordinal } from './lineup'
import {
  type GamePlay,
  type GameSetup,
  type GameState,
  type PlayerRef,
  type PlayEvent,
  type Side,
  withoutUndefined
} from './state'

/**
 * The stored play: a projection of the engine's state in Gumbo's own shape
 * and vocabulary. Nothing else writes one. The engine keeps numeric bases,
 * its reason labels and its own result types; this is where they become
 * `'1B'`, `r_adv_force` and `catcher_interf`. What Gumbo has no field for
 * stays in the `gameStation` record beside it.
 */

export interface PlayStamp {
  setupBefore: GameSetup
  actions: ScoringAction[]
  startTime?: string | null
  endTime?: string | null
}

// ---- Event types ----

/** The engine's result types MLB writes under another code. */
const LISTED_TYPES: Record<string, string> = {
  catcher_interference: 'catcher_interf',
  manual_placement: 'gs_manual_placement',
  placed_runner: 'runner_placed'
}
const BATTER_OUT_OTHER = 'Batter Out — Other'

/**
 * The event type a stored play carries for the engine's `type`. `other_out`
 * is MLB's runner out between pitches; the batter's own out of that kind, a
 * completed plate appearance, is `gs_batter_out`.
 */
export function storedEventType(type: string, outcome?: string): string {
  if (type === 'other_out' && outcome === BATTER_OUT_OTHER)
    return 'gs_batter_out'
  return LISTED_TYPES[type] ?? type
}

function playEventType(play: GamePlay): string {
  return storedEventType(play.result.eventType, play.source.gamestation.outcome)
}

// ---- Runners ----

type Runner = GamePlay['runners'][number]

const BASE_NAMES = [null, '1B', '2B', '3B', 'score'] as const
/** A base as Gumbo names it; the plate is none. */
function baseName(base: number): '1B' | '2B' | '3B' | 'score' | null {
  return BASE_NAMES[base] ?? null
}
/** Where a runner was put out: the batter retired at the plate is out at first. */
function outBaseName(base: number): string {
  return base <= 1 ? '1B' : base >= 4 ? '4B' : `${base}B`
}
/** The base a steal or a caught stealing was headed for: `2b`, `3b`, `home`. */
function target(base: number): string {
  return base >= 4 ? 'home' : `${base}b`
}

/**
 * The event type of the action that made a movement, read from the engine's
 * reason for it, or null when the reason names no action of its own.
 */
function actionType(runner: Runner): string | null {
  const { start: from, end: to } = runner.movement
  switch (runner.details.movementReason) {
    case 'Wild Pitch':
      return 'wild_pitch'
    case 'Passed Ball':
      return 'passed_ball'
    case 'Balk':
      return 'balk'
    case 'Steal':
      return `stolen_base_${target(to)}`
    case 'Caught Stealing':
      return `caught_stealing_${target(to)}`
    case 'Picked Off':
      return to > from
        ? `pickoff_caught_stealing_${target(to)}`
        : `pickoff_${from}b`
    case 'Safe from Pickoff':
      return `pickoff_${from}b`
    case 'Defensive Indifference':
      return 'defensive_indiff'
    case 'Throwing Error':
    case 'Fielding Error':
      return 'error'
    case 'Place a Runner (Tiebreaker)':
      return 'runner_placed'
    default:
      return null
  }
}

/**
 * The event type of a runner's movement: the action that made it, or the
 * play's own type for a movement the play made.
 */
function runnerEventType(runner: Runner, playType: string): string {
  return (
    actionType(runner) ??
    (runner.details.byAction === true
      ? runner.movement.isOut
        ? 'other_out'
        : 'other_advance'
      : playType)
  )
}

/**
 * Why a runner other than the batter moved, as MLB's runner detail types say
 * it. `onThrow` is a runner who took his base while the defence made a play
 * on another runner — not on the batter, whose out at first or on a catch is
 * the play every runner advances on.
 */
function movementReason(runner: Runner, onThrow: boolean): string {
  const { start: from, end: to, isOut } = runner.movement
  const reason = runner.details.movementReason
  if (isOut) {
    if (runner.movement.forceOut) return 'r_force_out'
    switch (reason) {
      case 'Caught Stealing':
        return `r_caught_stealing_${target(to)}`
      case 'Picked Off':
        return to > from
          ? `r_pickoff_caught_stealing_${target(to)}`
          : `r_pickoff_${from}b`
      case 'Ball Caught':
        return 'r_doubled_off'
      case 'Offensive Interference':
      case 'Batter Interference':
        return 'r_interference'
      case 'Out on Appeal':
        return 'r_out_appeal'
      case 'Back':
        return 'r_out_returning'
      default:
        return 'r_thrown_out'
    }
  }
  // A balk moves every runner up, but only the batter forces one.
  if (runner.movement.forced === true && reason !== 'Balk') return 'r_adv_force'
  if (reason === 'Steal') return `r_stolen_base_${target(to)}`
  if (onThrow) return 'r_adv_throw'
  return 'r_adv_play'
}

interface Person {
  id?: number
  fullName: string
}

function playerOf(
  state: GameState,
  setup: GameSetup,
  id: number
): { userId: number | null; fullName: string; teamId: string } | null {
  const player = state.gameData.players[id] ?? setup.players[id]
  return player == null
    ? null
    : {
        userId: player.userId,
        fullName: player.fullName,
        teamId: player.teamId
      }
}

/** A player as a stored play names him: his user id, or only his name. */
function person(state: GameState, setup: GameSetup, ref: PlayerRef): Person {
  const player = playerOf(state, setup, ref.id)
  const fullName = player?.fullName ?? ref.fullName
  return player?.userId == null ? { fullName } : { id: player.userId, fullName }
}

/**
 * The play's runners as Gumbo writes them, one entry per engine movement in
 * the order the engine made them.
 */
function runnersOf(
  state: GameState,
  setup: GameSetup,
  play: GamePlay,
  events: StoredEvents
): Array<Record<string, unknown>> {
  const who = (ref: PlayerRef): Person => person(state, setup, ref)
  const type = playEventType(play)
  const origin = new Map<number, number>()
  return play.runners.map((runner, i) => {
    const { movement, details } = runner
    const id = details.runner.id
    if (!origin.has(id)) origin.set(id, movement.start)
    const batter = id === play.matchup.batter.id && movement.start === 0
    const scored = movement.runScored === true && !movement.isOut
    // A run a third-out force took back leaves the runner where he stood.
    const end = movement.isOut
      ? null
      : movement.end === 4 && !scored
        ? baseName(movement.start)
        : baseName(movement.end)
    const eventType = runnerEventType(runner, type)
    const onThrow =
      details.movementReason === 'Advance' &&
      details.byAction !== true &&
      play.runners
        .slice(0, i)
        .some(
          other =>
            other.details.runner.id !== id &&
            other.movement.start !== 0 &&
            other.details.playIndex === details.playIndex &&
            (other.movement.isOut ||
              other.details.movementReason === 'Safe at home')
        )
    const charged =
      scored || (batter && (type === 'walk' || type === 'intent_walk'))
    const pitcher = details.responsiblePitcher
    return {
      movement: {
        originBase: baseName(origin.get(id)!),
        start: baseName(movement.start),
        end,
        outBase: movement.isOut ? outBaseName(movement.end) : null,
        isOut: movement.isOut,
        outNumber: movement.isOut ? (movement.outNumber ?? null) : null
      },
      details: {
        event: eventTypeName(eventType),
        eventType,
        movementReason: batter ? null : movementReason(runner, onThrow),
        runner: who(details.runner),
        responsiblePitcher:
          charged && pitcher != null
            ? { id: playerOf(state, setup, pitcher.id)?.userId ?? null }
            : null,
        isScoringEvent: scored,
        rbi: details.rbi === true,
        earned: details.earned === true,
        teamUnearned: details.teamUnearned === true,
        playIndex:
          details.playIndex == null ? null : events.indexOf(details.playIndex)
      },
      credits: runner.credits.map(credit => {
        const position = GAME_POSITIONS.get(credit.position)
        return {
          player: who(credit.player),
          ...(position == null ? {} : { position: { ...position } }),
          credit: credit.credit
        }
      })
    }
  })
}

// ---- Play events ----

/** Each call as the live feed describes it. */
const CALL_DESCRIPTIONS: Record<string, string> = {
  B: 'Ball',
  C: 'Called Strike',
  S: 'Swinging Strike',
  F: 'Foul',
  T: 'Foul Tip',
  L: 'Foul Bunt',
  H: 'Hit By Pitch',
  X: 'In play, out(s)',
  D: 'In play, no out',
  E: 'In play, run(s)'
}
const STRIKE_CALLS: ReadonlySet<string> = new Set(['C', 'S', 'F', 'T', 'L'])
const BALL_CALLS: ReadonlySet<string> = new Set(['B', 'H'])

/** The event types of what a play came to without a pitch, by the engine's name. */
const PLAY_ACTION_TYPES: Record<string, string> = {
  balk: 'balk',
  placed_runner: 'runner_placed',
  intent_walk: 'intent_walk',
  catcher_interference: 'catcher_interf',
  manual_placement: 'gs_manual_placement',
  other_out: 'gs_batter_out'
}
/** Awarded to the batter with no pitch: the sentence is about him. */
const BATTER_ACTIONS: ReadonlySet<string> = new Set([
  'intent_walk',
  'catcher_interf',
  'gs_manual_placement',
  'gs_batter_out'
])
/** The pitcher's doing: the sentence names him. */
const PITCHER_ACTIONS: ReadonlySet<string> = new Set(['balk', 'wild_pitch'])

function scoredRunner(runner: Runner): boolean {
  return runner.movement.runScored === true && !runner.movement.isOut
}

/**
 * The runner entries an event made: those that name it as their play event,
 * and the one a runner's action wrote.
 */
function entriesOf(play: GamePlay, event: PlayEvent): Runner[] {
  const linked = event.details.runnerEntry
  return play.runners.filter(
    (runner, i) => i === linked || runner.details.playIndex === event.index
  )
}

/** What happened to a runner, after his name: `to 2nd`, `scores`, `out at 3rd`. */
function fate(runner: Runner): string {
  const { start, end, isOut } = runner.movement
  if (isOut)
    return `out at ${end <= 1 ? '1st' : end >= 4 ? 'home' : ordinal(end)}`
  if (scoredRunner(runner)) return 'scores'
  // A run taken back, or a runner the play did not move.
  return end >= 4 || end === start
    ? `stays at ${ordinal(start)}`
    : `to ${ordinal(end)}`
}

/**
 * Who an action names first: the pitcher of a balk or a wild pitch, the
 * batter of an award, or the runner who acted, with the player the clause
 * already speaks for. The pitcher is the one on the mound at the event, not
 * the matchup's, which a later change in the plate appearance replaces: a
 * runner's action carries him, and a balk is his own event.
 */
function leadOf(
  name: (ref: PlayerRef) => string,
  play: GamePlay,
  event: PlayEvent,
  eventType: string,
  entries: Runner[]
): { credit: DescribedCredit; player: number | null } | null {
  const credit = (
    who: string,
    role: string,
    label: string
  ): DescribedCredit => ({
    eventType,
    label,
    credit: { name: who, role, position: null }
  })
  const title = eventTypeName(eventType)
  if (PITCHER_ACTIONS.has(eventType))
    return {
      credit: credit(name(event.pitcher ?? event.player), 'pitcher', title),
      player: null
    }
  if (eventType === 'passed_ball')
    return {
      credit: { eventType, label: title, credit: null },
      player: null
    }
  if (BATTER_ACTIONS.has(eventType)) {
    const batter = name(play.matchup.batter)
    return {
      credit: credit(batter, 'batter', `${title}: ${batter}`),
      player: play.matchup.batter.id
    }
  }
  const runner = entries.at(0)
  if (runner == null) return null
  const who = name(runner.details.runner)
  // A steal or an out names the base itself; anything else says where to.
  const said = eventType.startsWith('stolen_base') || runner.movement.isOut
  return {
    credit: credit(
      who,
      'runner',
      `${title}: ${said ? who : `${who} ${fate(runner)}`}`
    ),
    player: runner.details.runner.id
  }
}

/**
 * An action in a sentence: who did it, then where each runner it moved went,
 * `Wild pitch by Joe P. Chase T to 3rd. Kyle M to 2nd.` A runner's own action
 * names him first, `Chase T steals second.`
 */
function actionDescription(
  state: GameState,
  setup: GameSetup,
  play: GamePlay,
  event: PlayEvent,
  eventType: string,
  entries: Runner[]
): string {
  const name = (ref: PlayerRef): string => person(state, setup, ref).fullName
  const lead = leadOf(name, play, event, eventType, entries)
  const credits: DescribedCredit[] = lead == null ? [] : [lead.credit]
  for (const runner of entries)
    if (
      runner.details.runner.id !== lead?.player &&
      (runner.movement.isOut || runner.movement.end !== runner.movement.start)
    )
      credits.push({
        eventType: 'other_advance',
        label: `${name(runner.details.runner)} ${fate(runner)}`,
        credit: null
      })
  return describePlay({ eventType, credits })
}

/**
 * A pitch as Gumbo writes it: its call, what the call means, and the count it
 * left. The in-play pitch is `E` when the play scored a run on it, `X` when it
 * made an out, and `D` otherwise.
 */
function pitchDocument(
  event: PlayEvent,
  pitchNumber: number,
  made: Runner[],
  who: (ref: PlayerRef) => Person
): Record<string, unknown> {
  const isOut = made.some(runner => runner.movement.isOut)
  const isInPlay = event.details.isInPlay === true
  const code = !isInPlay
    ? event.details.code
    : made.some(scoredRunner)
      ? 'E'
      : isOut
        ? 'X'
        : 'D'
  const description = CALL_DESCRIPTIONS[code] ?? event.details.description
  return {
    index: event.index,
    pitchNumber,
    isPitch: true,
    type: 'pitch',
    details: {
      call: { code, description },
      code,
      description,
      isInPlay,
      isStrike: STRIKE_CALLS.has(code),
      isBall: BALL_CALLS.has(code),
      isOut,
      hasReview: false
    },
    count: { ...event.count },
    player: who(event.player),
    // No action says when it happened; the play's own times are on `about`.
    startTime: null,
    endTime: null
  }
}

/**
 * An action as Gumbo writes it: the event type of the runner entry it made,
 * or of what the play came to, and a sentence.
 */
function actionDocument(
  state: GameState,
  setup: GameSetup,
  play: GamePlay,
  event: PlayEvent,
  made: Runner[],
  score: Score
): Record<string, unknown> {
  const playType = playEventType(play)
  const first = made.at(0)
  const eventType =
    first == null
      ? (PLAY_ACTION_TYPES[event.details.code] ?? playType)
      : runnerEventType(first, playType)
  const isBaseRunningPlay =
    eventType === 'balk' ||
    (eventType !== 'runner_placed' &&
      made.some(runner => runner.details.byAction === true))
  return {
    index: event.index,
    isPitch: false,
    // The feed marks base running on the event, and only where it is true.
    ...(isBaseRunningPlay ? { isBaseRunningPlay } : {}),
    type: 'action',
    details: {
      description: actionDescription(
        state,
        setup,
        play,
        event,
        eventType,
        made
      ),
      event: eventTypeName(eventType),
      eventType,
      awayScore: score.away,
      homeScore: score.home,
      isScoringPlay: made.some(scoredRunner),
      isOut: made.some(runner => runner.movement.isOut),
      hasReview: false
    },
    count: { ...event.count },
    player: person(state, setup, event.player),
    startTime: null,
    endTime: null
  }
}

interface Score {
  away: number
  home: number
}

/**
 * The score after each of the play's actions. Runner entries are written in
 * the order they happened, so an action's score counts every run among the
 * entries up to the last one it made: the one a runner's action wrote, or
 * those that name it, or name an event before it. A pitch's own entries are
 * counted by the actions after it; an in-play pitch's are still being
 * written while the scorer decides the play.
 */
function scoresAfter(play: GamePlay): Score[] {
  const runs = play.runners.map((runner): number =>
    scoredRunner(runner) ? 1 : 0
  )
  const total = runs.reduce((sum, run) => sum + run, 0)
  const batting = play.about.halfInning === 'top' ? 'away' : 'home'
  // A completed play is stamped with the score it left; one in progress
  // still holds the score it began with.
  const start: Score = {
    away: play.result.awayScore,
    home: play.result.homeScore
  }
  if (play.about.isComplete) start[batting] -= total
  let upTo = -1
  return play.playEvents.map(event => {
    const linked = event.details.runnerEntry
    if (event.isPitch) return start
    play.runners.forEach((runner, i) => {
      const at = runner.details.playIndex ?? -1
      if (linked == null ? at <= event.index : at === event.index)
        upTo = Math.max(upTo, i)
    })
    if (linked != null) upTo = Math.max(upTo, linked)
    const scored = runs.slice(0, upTo + 1).reduce((sum, run) => sum + run, 0)
    return { ...start, [batting]: start[batting] + scored }
  })
}

/**
 * The engine's events a stored play keeps, and where each lands. MLB writes
 * no event for a runner the ball in play moved: his entry points at the
 * in-play pitch, as the engine's does already. The engine also writes an
 * event for each runner the scorer moves or puts out while a play is being
 * decided — the batter caught on a fly, a runner sent home on a double — and
 * those are left out, so every event after one moves up.
 */
interface StoredEvents {
  kept: PlayEvent[]
  /** The stored index of the engine's event at `index`. */
  indexOf: (index: number) => number
}
function storedEvents(play: GamePlay): StoredEvents {
  const kept = play.playEvents.filter(event => {
    const linked = event.details.runnerEntry
    return linked == null || play.runners[linked]?.details.byAction === true
  })
  return {
    kept,
    indexOf: index => kept.filter(event => event.index < index).length
  }
}

/** The play's events as Gumbo writes them, each with the runner entries it made. */
function playEventsOf(
  state: GameState,
  setup: GameSetup,
  play: GamePlay,
  events: StoredEvents
): Array<Record<string, unknown>> {
  const who = (ref: PlayerRef): Person => person(state, setup, ref)
  const scores = scoresAfter(play)
  let pitchNumber = 0
  return events.kept.map(event => {
    const made = entriesOf(play, event)
    const written = event.isPitch
      ? pitchDocument(event, ++pitchNumber, made, who)
      : actionDocument(state, setup, play, event, made, scores[event.index])
    return { ...written, index: events.indexOf(event.index) }
  })
}

// ---- Highlight credits ----

function sideOf(state: GameState, teamId: string | undefined): Side {
  return teamId === state.gameData.teams.home.id ? 'home' : 'away'
}

interface HighlightCredit {
  eventType: string
  label: string
  teamId: Side
  creditUserId: number | null
  credit: { name: string; role: string; position: string | null }
}

const BATTER_CREDITED = new Set([
  'single',
  'double',
  'triple',
  'home_run',
  'walk',
  'intent_walk',
  'hit_by_pitch',
  'catcher_interf',
  'gs_manual_placement',
  'sac_fly',
  'sac_fly_double_play',
  'sac_bunt'
])
const PITCHER_CREDITED = new Set(['strikeout', 'strikeout_double_play'])
const FIELDER_CREDITED = new Set([
  'field_out',
  'other_out',
  'gs_batter_out',
  'grounded_into_double_play',
  'triple_play',
  'caught_stealing',
  'pickoff_1b',
  'pickoff_2b',
  'pickoff_3b'
])

/**
 * The credits a highlight shows for a completed play: the batter who reached,
 * the pitcher who struck him out, the fielders who made the outs, and each
 * runner who scored or stole. All of it is read from the engine's play — its
 * numeric bases, `runScored` and its own steal — never from what is stored.
 * A play nobody did anything worth watching on carries an empty list.
 */
function highlightCredits(
  state: GameState,
  setup: GameSetup,
  play: GamePlay
): HighlightCredit[] {
  const type = playEventType(play)
  const credits: HighlightCredit[] = []
  const add = (
    ref: PlayerRef,
    eventType: string,
    head: string,
    role: string,
    position: string | null = null,
    detail = ''
  ): void => {
    const player = playerOf(state, setup, ref.id)
    const name = player?.fullName ?? ref.fullName
    credits.push({
      eventType,
      label: `${head}: ${name}${position == null ? '' : ` (${position})`}${detail}`,
      teamId: sideOf(state, player?.teamId),
      creditUserId: player?.userId ?? null,
      credit: { name, role, position }
    })
  }
  if (BATTER_CREDITED.has(type))
    add(play.matchup.batter, type, eventTypeName(type), 'batter')
  if (PITCHER_CREDITED.has(type))
    add(play.matchup.pitcher, type, eventTypeName(type), 'pitcher')
  if (FIELDER_CREDITED.has(type))
    for (const runner of play.runners)
      if (runner.movement.isOut) {
        const putout = runner.credits.find(c => c.credit === 'f_putout')
        if (putout == null) continue
        const assists = runner.credits
          .filter(c => c.credit === 'f_assist')
          .map(c => `${c.player.fullName} (${c.position})`)
        add(
          putout.player,
          type,
          runner.movement.end === 0
            ? 'Out'
            : `Out at ${runner.movement.end === 4 ? 'home' : ordinal(runner.movement.end)}`,
          'fielder',
          putout.position,
          assists.length === 0 ? '' : ` from ${assists.join(', ')}`
        )
      }
  for (const runner of play.runners) {
    if (runner.movement.runScored === true && !runner.movement.isOut)
      add(runner.details.runner, 'run', 'Run', 'runner')
    if (runner.details.movementReason === 'Steal' && !runner.movement.isOut)
      add(runner.details.runner, 'stolen_base', 'Stolen base', 'runner')
  }
  return credits
}

// ---- Documents ----

function documentBody(
  state: GameState,
  play: GamePlay,
  stamp: PlayStamp
): Record<string, unknown> {
  const setup = stamp.setupBefore
  const who = (ref: PlayerRef): Person => person(state, setup, ref)
  const events = storedEvents(play)
  const runners = runnersOf(state, setup, play, events)
  return {
    about: {
      atBatIndex: play.about.atBatIndex,
      inning: play.about.inning,
      halfInning: play.about.halfInning,
      isComplete: play.about.isComplete,
      isScoringPlay: play.runners.some(
        runner => runner.movement.runScored === true && !runner.movement.isOut
      ),
      startTime: stamp.startTime ?? null,
      endTime: stamp.endTime ?? null
    },
    count: { ...play.count },
    matchup: {
      batter: who(play.matchup.batter),
      pitcher: who(play.matchup.pitcher),
      batSide: { code: play.matchup.batSide.code }
    },
    runners,
    playEvents: playEventsOf(state, setup, play, events),
    pitchIndex: events.kept
      .filter(event => event.isPitch)
      .map(event => events.indexOf(event.index)),
    actionIndex: events.kept
      .filter(event => !event.isPitch)
      .map(event => events.indexOf(event.index)),
    runnerIndex: runners.map((runner, i) => i),
    ...(play.hitData == null
      ? {}
      : {
          hitData: {
            launchAngle: play.hitData.launchAngle,
            trajectory: play.hitData.trajectory,
            coordinates: { ...play.hitData.coordinates },
            ...(play.hitData.fielder == null
              ? {}
              : { fielder: who(play.hitData.fielder) })
          }
        }),
    gameStation: {
      version: 1,
      setupBefore: stamp.setupBefore,
      actions: stamp.actions,
      detail: play.source.gamestation
    }
  }
}

/** A completed play, ready to store. */
export function documentOf(
  state: GameState,
  play: GamePlay,
  stamp: PlayStamp
): GumboPlay {
  return asGumboPlay(
    withoutUndefined({
      ...documentBody(state, play, stamp),
      result: {
        type: 'atBat',
        event: play.result.event,
        eventType: playEventType(play),
        description: play.result.description,
        rbi: play.result.rbi,
        awayScore: play.result.awayScore,
        homeScore: play.result.homeScore
      },
      credits: highlightCredits(state, stamp.setupBefore, play)
    })
  )
}

/**
 * The at-bat in progress: no outcome and no score, because it has none yet.
 * When the batter due is on base there is no play, and the record rides on a
 * play that names only its place in the game.
 */
export function currentDocumentOf(
  state: GameState,
  play: GamePlay | null,
  stamp: PlayStamp
): CurrentPlay {
  if (play == null) {
    const line = state.liveData.linescore
    return asCurrentPlay({
      about: {
        atBatIndex: state.liveData.plays.allPlays.length,
        inning: line.currentInning,
        halfInning: line.isTopInning ? 'top' : 'bottom',
        isComplete: false
      },
      gameStation: {
        version: 1,
        setupBefore: stamp.setupBefore,
        actions: stamp.actions
      }
    })
  }
  const body = documentBody(state, play, stamp)
  return asCurrentPlay(
    withoutUndefined({
      ...body,
      about: { ...(body.about as object), isComplete: false }
    })
  )
}

/** The last play of a game, at index 9999: its final score. */
export const FINAL_INDEX = 9999
export function finalDocumentOf(state: GameState, stamp: PlayStamp): GumboPlay {
  const line = state.liveData.linescore
  return asGumboPlay({
    about: {
      atBatIndex: FINAL_INDEX,
      inning: line.currentInning,
      halfInning: line.isTopInning ? 'top' : 'bottom',
      isComplete: true,
      startTime: stamp.startTime ?? null,
      endTime: stamp.endTime ?? null
    },
    result: {
      type: 'atBat',
      event: 'Game over',
      eventType: 'final_score',
      description: 'Game over',
      awayScore: line.teams.away.runs,
      homeScore: line.teams.home.runs,
      rbi: 0
    },
    pitchIndex: [],
    actionIndex: [],
    runnerIndex: [],
    credits: [],
    gameStation: {
      version: 1,
      setupBefore: stamp.setupBefore,
      actions: stamp.actions
    }
  })
}
