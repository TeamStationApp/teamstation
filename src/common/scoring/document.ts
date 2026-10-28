import { type DescribedCredit, describePlay } from '../describePlay'
import { DEFAULT_FENCE_DISTANCE_FT } from '../fenceDistance'
import { GAME_POSITIONS, mlbEventName } from '../gumbo/reference'
import { eventTypeName } from '../gumboEventTypes'
import {
  asCurrentPlay,
  asGumboPlay,
  type CurrentPlay,
  type GumboPlay
} from '../gumboPlay'
import type { ScoringAction } from './actions'
import {
  battersOf,
  battingOrderSaid,
  defensiveSubstitutionSaid,
  fieldingChanges,
  type LineupSaid,
  ordinal,
  pinchSaid,
  type SaidName,
  saidNames,
  type SaidPlayer
} from './lineup'
import { PARK } from './park'
import { trajectoryOf } from './rules'
import {
  fenceOf,
  type GamePlay,
  type GameSetup,
  type GameState,
  type PlayerRef,
  type PlayEvent,
  type Point,
  type Position,
  POSITIONS,
  type RunnerCredit,
  type Side,
  type SideLineup,
  withoutUndefined
} from './state'
import {
  actionByTeam,
  setupByTeam,
  type SideTeams,
  type TeamSetup
} from './teamRecord'

/** The fence a game is played to; `state.ts` keeps it beside the field. */
export { fenceOf }

/**
 * The stored play: a projection of the engine's state in Gumbo's own shape
 * and vocabulary. Nothing else writes one. The engine keeps numeric bases,
 * its reason labels and its own result types; this is where they become
 * `'1B'`, `r_adv_force` and `catcher_interf`. What Gumbo has no field for
 * stays in the `teamStation` record beside it.
 */

export interface PlayStamp {
  setupBefore: GameSetup
  actions: ScoringAction[]
  /** When each action was taken, one per action; undefined where unknown. */
  actionTimes?: ReadonlyArray<string | undefined>
  /** Historical playback clock, separate from radar correction times. */
  playbackTimes?: ReadonlyArray<string | undefined>
  startTime?: string | null
  endTime?: string | null
}

/** Each setup by team, made once per setup and pair of teams. */
const teamSetups = new WeakMap<GameSetup, { key: string; setup: TeamSetup }>()

/**
 * The record a play stores: version 3, its setup and its lineup changes by
 * team under the teams the engine played it with (`teams`).
 */
function teamStationOf(
  teams: SideTeams,
  stamp: PlayStamp,
  detail?: unknown
): Record<string, unknown> {
  const key = `${teams.away.id}\u0000${teams.home.id}`
  let made = teamSetups.get(stamp.setupBefore)
  if (made?.key !== key) {
    made = { key, setup: setupByTeam(stamp.setupBefore, teams) }
    teamSetups.set(stamp.setupBefore, made)
  }
  return {
    version: 3,
    setupBefore: made.setup,
    ...recordActions(stamp, teams),
    ...(detail === undefined ? {} : { detail })
  }
}

/**
 * The record's actions and their times. The times are written only when
 * every action has one, so a reader can trust the two lists line up.
 */
function recordActions(
  stamp: PlayStamp,
  teams: SideTeams
): {
  actions: Array<Record<string, unknown>>
  actionTimes?: string[]
  playbackTimes?: string[]
} {
  const times = stamp.actionTimes
  const actions = stamp.actions.map(action => actionByTeam(action, teams))
  return times != null &&
    stamp.actions.length > 0 &&
    times.length === stamp.actions.length &&
    times.every(time => time != null)
    ? {
        actions,
        actionTimes: [...times] as string[],
        ...(stamp.playbackTimes?.length === times.length &&
        stamp.playbackTimes.every(time => time != null) &&
        stamp.playbackTimes.some((time, i) => time !== times[i])
          ? { playbackTimes: [...stamp.playbackTimes] as string[] }
          : {})
      }
    : { actions }
}

// ---- Event types ----

/** The engine's result types MLB writes under another code. */
const LISTED_TYPES: Record<string, string> = {
  catcher_interference: 'catcher_interf',
  manual_placement: 'ts_manual_placement',
  placed_runner: 'runner_placed'
}
const BATTER_OUT_OTHER = 'Batter Out — Other'

/**
 * The event type a stored play carries for the engine's `type`. `other_out`
 * is MLB's runner out between pitches; the batter's own out of that kind, a
 * completed plate appearance, is `ts_batter_out`.
 */
export function storedEventType(type: string, outcome?: string): string {
  if (type === 'other_out' && outcome === BATTER_OUT_OTHER)
    return 'ts_batter_out'
  return LISTED_TYPES[type] ?? type
}

function playEventType(play: GamePlay): string {
  return storedEventType(play.result.eventType, play.source.teamstation.outcome)
}

/**
 * What MLB calls an event of this play: the list's name for its type, except
 * that an out on a ball in play is named by how it was made, from the out the
 * scorer chose and the ball's trajectory.
 */
function eventName(type: string, play: GamePlay): string {
  if (type !== 'field_out') return mlbEventName(type)
  const detail = play.source.teamstation
  const bunt = detail.contactKind === 'bunt' ? 'Bunt ' : ''
  if (detail.outSubtype === 'Throw Out') return `${bunt}Groundout`
  if (detail.outSubtype !== 'Ball Caught') return mlbEventName(type)
  switch (play.hitData?.trajectory) {
    case 'Pop Fly':
      return `${bunt}Pop Out`
    case 'Line Drive':
    case 'Ground Ball':
    case 'Chopper':
      return `${bunt}Lineout`
    default:
      return bunt === '' ? 'Flyout' : 'Bunt Pop Out'
  }
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
): { id: number; fullName: string; teamId: string } | null {
  const player = state.gameData.players[id] ?? setup.players[id]
  return player == null
    ? null
    : {
        id: player.id,
        fullName: player.fullName,
        teamId: player.teamId
      }
}

/** A player as a stored play names him: his user id, or only his name. */
function person(state: GameState, setup: GameSetup, ref: PlayerRef): Person {
  const player = playerOf(state, setup, ref.id)
  const fullName = player?.fullName ?? ref.fullName
  return player?.id == null ? { fullName } : { id: player.id, fullName }
}

/** A player as a sentence's `said` names him: his id, or his name alone. */
function saidOf(who: Person): SaidPlayer {
  return who.id ?? { name: who.fullName }
}

/** The names the game gives the players a sentence names by id. */
function gameNames(state: GameState, setup: GameSetup): SaidName {
  return saidNames(id => playerOf(state, setup, id)?.fullName)
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
        event: eventName(eventType, play),
        eventType,
        movementReason: batter ? null : movementReason(runner, onThrow),
        runner: who(details.runner),
        responsiblePitcher:
          charged && pitcher != null
            ? { id: playerOf(state, setup, pitcher.id)?.id ?? null }
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
  manual_placement: 'ts_manual_placement',
  other_out: 'ts_batter_out'
}
/** Awarded to the batter with no pitch: the sentence is about him. */
const BATTER_ACTIONS: ReadonlySet<string> = new Set([
  'intent_walk',
  'catcher_interf',
  'ts_manual_placement',
  'ts_batter_out'
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

/** Who an action's sentence names first, and as what. */
export type ActionRole = 'pitcher' | 'catcher' | 'batter' | 'runner'

/**
 * What an action's sentence is made from: its event type and who it names
 * first. The runners it moved are the play's own, those whose entry names
 * the event (`ActionMove`).
 */
export interface ActionSaid {
  kind: 'action'
  eventType: string
  lead?: { player: SaidPlayer; role: ActionRole }
}

/** What a described event's sentence is made from, kept beside it. */
export type EventSaid = LineupSaid | ActionSaid

/**
 * A runner an action moved, as its sentence tells it: who, and his bases as
 * numbers, the plate 0 and home 4.
 */
export interface ActionMove {
  player: SaidPlayer
  start: number
  end: number
  isOut: boolean
  scored: boolean
}

function samePlayer(a: SaidPlayer, b: SaidPlayer): boolean {
  return typeof a === 'number'
    ? a === b
    : typeof b !== 'number' && a.name === b.name
}

/** What happened to a runner, after his name: `to 2nd`, `scores`, `out at 3rd`. */
function fate(move: ActionMove): string {
  const { start, end, isOut } = move
  if (isOut)
    return `out at ${end <= 1 ? '1st' : end >= 4 ? 'home' : ordinal(end)}`
  if (move.scored) return 'scores'
  // A run taken back, or a runner the play did not move.
  return end >= 4 || end === start
    ? `stays at ${ordinal(start)}`
    : `to ${ordinal(end)}`
}

/**
 * An action in a sentence: who did it, then where each runner it moved went,
 * `Wild pitch by Joe P. Chase T to 3rd. Kyle M to 2nd.` A runner's own action
 * names him first, `Chase T steals second.` The lead is the pitcher of a balk
 * or a wild pitch, the catcher of a passed ball, the batter of an award, or
 * the runner who acted; the moves are the runners the action moved, in order.
 */
export function actionSentence(
  name: SaidName,
  eventType: string,
  lead: ActionSaid['lead'],
  moves: readonly ActionMove[]
): string {
  const title = eventTypeName(eventType)
  const credits: DescribedCredit[] = []
  const credit = (who: string, role: string, label: string): void => {
    credits.push({
      eventType,
      label,
      credit: { name: who, role, position: null }
    })
  }
  // The player the lead clause already speaks for.
  let spoken: SaidPlayer | undefined
  if (lead == null) {
    if (eventType === 'passed_ball')
      credits.push({ eventType, label: title, credit: null })
  } else {
    const who = name(lead.player)
    if (lead.role === 'pitcher' || lead.role === 'catcher')
      credit(who, lead.role, title)
    else if (lead.role === 'batter') {
      credit(who, 'batter', `${title}: ${who}`)
      spoken = lead.player
    } else {
      const runner = moves.find(move => samePlayer(move.player, lead.player))
      // A steal or an out names the base itself; anything else says where to.
      const said =
        runner == null || eventType.startsWith('stolen_base') || runner.isOut
      credit(
        who,
        'runner',
        `${title}: ${said ? who : `${who} ${fate(runner)}`}`
      )
      spoken = lead.player
    }
  }
  for (const move of moves)
    if (
      (spoken == null || !samePlayer(move.player, spoken)) &&
      (move.isOut || move.end !== move.start)
    )
      credits.push({
        eventType: 'other_advance',
        label: `${name(move.player)} ${fate(move)}`,
        credit: null
      })
  return describePlay({ eventType, credits })
}

/** An engine runner as an action's sentence tells him. */
function moveOf(
  state: GameState,
  setup: GameSetup,
  runner: Runner
): ActionMove {
  return {
    player: saidOf(person(state, setup, runner.details.runner)),
    start: runner.movement.start,
    end: runner.movement.end,
    isOut: runner.movement.isOut,
    scored: scoredRunner(runner)
  }
}

/**
 * Who an action names first: the pitcher of a balk or a wild pitch, the
 * batter of an award, or the runner who acted. The pitcher is the one on the
 * mound at the event, not the matchup's, which a later change in the plate
 * appearance replaces: a runner's action carries him, and a balk is his own
 * event.
 */
function leadOf(
  state: GameState,
  setup: GameSetup,
  play: GamePlay,
  event: PlayEvent,
  eventType: string,
  entries: Runner[]
): ActionSaid['lead'] {
  const who = (ref: PlayerRef): SaidPlayer => saidOf(person(state, setup, ref))
  if (PITCHER_ACTIONS.has(eventType))
    return { player: who(event.pitcher ?? event.player), role: 'pitcher' }
  if (eventType === 'passed_ball')
    return event.catcher == null
      ? undefined
      : { player: who(event.catcher), role: 'catcher' }
  if (BATTER_ACTIONS.has(eventType))
    return { player: who(play.matchup.batter), role: 'batter' }
  const runner = entries.at(0)
  return runner == null
    ? undefined
    : { player: who(runner.details.runner), role: 'runner' }
}

/** An action's sentence, and what it is made from. */
function actionDescription(
  state: GameState,
  setup: GameSetup,
  play: GamePlay,
  event: PlayEvent,
  eventType: string,
  entries: Runner[]
): { description: string; said: ActionSaid } {
  const lead = leadOf(state, setup, play, event, eventType, entries)
  return {
    description: actionSentence(
      gameNames(state, setup),
      eventType,
      lead,
      entries.map(runner => moveOf(state, setup, runner))
    ),
    said: withoutUndefined({ kind: 'action' as const, eventType, lead })
  }
}

// ---- Hit data ----

/** MLB's batted-ball trajectory for the scorer's, bunts on their own list. */
const HIT_TRAJECTORIES: Record<string, { swing: string; bunt: string }> = {
  ground_ball: { swing: 'ground_ball', bunt: 'bunt_grounder' },
  chopper: { swing: 'ground_ball', bunt: 'bunt_grounder' },
  line_drive: { swing: 'line_drive', bunt: 'bunt_line_drive' },
  fly_ball: { swing: 'fly_ball', bunt: 'bunt_popup' },
  popup: { swing: 'popup', bunt: 'bunt_popup' }
}

/**
 * MLB's spray chart is a 250 by 250 grid with home plate at (125, 204), x
 * growing toward right field and y toward the plate. The reference feed's
 * fly balls put 2.4 feet in each grid unit: its `totalDistance` over the grid
 * distance from home is 2.39 to 2.43 for 14 of the 19, and 2.41 at the
 * median.
 *
 * The field model's fence is a circle `PARK.outfieldRadius` units from home,
 * with centre field negative z. The model is drawn one size, and the game
 * says how big it stands for: its fence distance in feet, so one model unit
 * is that over the radius. A 200-foot fence lands on the grid's arc 83.3
 * units out — straightaway centre at (125, 120.7), the foul poles at 45°
 * either side — and any fence F at F / 2.4.
 */
export const SPRAY_HOME = { coordX: 125, coordY: 204 } as const
export const FEET_PER_SPRAY_UNIT = 2.4

/** Feet in one unit of the field model, for a fence this far out. */
export function feetPerUnit(
  fenceDistanceFt: number = DEFAULT_FENCE_DISTANCE_FT
): number {
  return fenceDistanceFt / PARK.outfieldRadius
}

/** Where a point on the field sits on MLB's spray chart. */
export function sprayCoordinates(
  point: Point,
  fenceDistanceFt: number = DEFAULT_FENCE_DISTANCE_FT
): {
  coordX: number
  coordY: number
} {
  const perUnit = feetPerUnit(fenceDistanceFt) / FEET_PER_SPRAY_UNIT
  const round = (value: number): number => Math.round(value * 100) / 100
  return {
    coordX: round(SPRAY_HOME.coordX + point.x * perUnit),
    coordY: round(SPRAY_HOME.coordY + point.z * perUnit)
  }
}

/** How far from home plate a point on the field is, in whole feet. */
export function distanceFeet(
  point: Point,
  fenceDistanceFt: number = DEFAULT_FENCE_DISTANCE_FT
): number {
  return Math.round(Math.hypot(point.x, point.z) * feetPerUnit(fenceDistanceFt))
}

interface HitData {
  launchAngle?: number
  totalDistance?: number
  trajectory?: string
  location?: string
  coordinates?: { coordX: number; coordY: number }
}

/**
 * The ball in play as MLB writes it on the in-play pitch: the launch angle,
 * the trajectory, the fielder's position code as `location`, and where the
 * scorer put the ball, with how far that is from home plate on a field whose
 * fence stands `fenceDistanceFt` away. Each is written only when the scorer
 * gave it. The launch angle is written when the scorer set it on the field;
 * one estimated from a trajectory alone stays in the record with the
 * scorer's own trajectory.
 */
function hitDataOf(play: GamePlay, fenceDistanceFt: number): HitData | null {
  const hit = play.hitData
  if (hit == null) return null
  const detail = play.source.teamstation
  const picked =
    detail.trajectory ??
    (hit.launchAngle == null ? undefined : trajectoryOf(hit.launchAngle))
  const trajectory = picked == null ? undefined : HIT_TRAJECTORIES[picked]
  const location =
    hit.position == null ? undefined : GAME_POSITIONS.get(hit.position)?.code
  const distance =
    hit.coordinates == null
      ? undefined
      : distanceFeet(hit.coordinates, fenceDistanceFt)
  return withoutUndefined({
    launchAngle:
      detail.launchAngleSet === true && hit.launchAngle != null
        ? Math.round(hit.launchAngle * 10) / 10
        : undefined,
    // A ball put down on the plate itself went nowhere a distance can say.
    totalDistance: distance === 0 ? undefined : distance,
    trajectory:
      trajectory == null
        ? undefined
        : detail.contactKind === 'bunt'
          ? trajectory.bunt
          : trajectory.swing,
    location,
    coordinates:
      hit.coordinates == null
        ? undefined
        : sprayCoordinates(hit.coordinates, fenceDistanceFt)
  })
}

/**
 * A pitch as Gumbo writes it: its call, what the call means, the count it
 * left, and the speed and zone the scorer gave it. The in-play pitch is `E`
 * when the play scored a run on it, `X` when it made an out, and `D`
 * otherwise.
 */
function pitchDocument(
  event: PlayEvent,
  pitchNumber: number,
  made: Runner[],
  who: (ref: PlayerRef) => Person,
  hitData: HitData | null
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
      ...(event.details.type == null
        ? {}
        : { type: { ...event.details.type } }),
      isOut,
      hasReview: false
    },
    count: { ...event.count },
    ...(event.pitchData == null ? {} : { pitchData: { ...event.pitchData } }),
    ...(isInPlay && hitData != null ? { hitData } : {}),
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
  const { description, said } = actionDescription(
    state,
    setup,
    play,
    event,
    eventType,
    made
  )
  return {
    index: event.index,
    isPitch: false,
    // The feed marks base running on the event, and only where it is true.
    ...(isBaseRunningPlay ? { isBaseRunningPlay } : {}),
    type: 'action',
    details: {
      description,
      event: eventName(eventType, play),
      eventType,
      awayScore: score.away,
      homeScore: score.home,
      isScoringPlay: made.some(scoredRunner),
      isOut: made.some(runner => runner.movement.isOut),
      hasReview: false
    },
    said,
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
  const batting = play.about.halfInning === 'top' ? 'away' : 'home'
  const start = scoreBefore(play)
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

/** The score a play began with. */
function scoreBefore(play: GamePlay): Score {
  const batting = play.about.halfInning === 'top' ? 'away' : 'home'
  // A completed play is stamped with the score it left; one in progress
  // still holds the score it began with.
  const start: Score = {
    away: play.result.awayScore,
    home: play.result.homeScore
  }
  if (play.about.isComplete)
    start[batting] -= play.runners.filter(scoredRunner).length
  return start
}

/**
 * The lineup changes MLB writes when a side takes the field: a pitcher, and
 * a player coming in to field or changing position. A pinch hitter or runner
 * and a new batting order belong to the side at bat.
 */
const FIELDING_CHANGES: ReadonlySet<string> = new Set([
  'pitching_substitution',
  'defensive_substitution',
  'defensive_switch'
])

/**
 * A change to a side's fielders that the play it was made in does not write,
 * because MLB announces it only when that side takes the field
 * (`takingTheField`): one the side at bat made — a pinch hitter who stays in
 * to play third, a pitcher who starts the next inning — and, when this play
 * is the first its fielders field, one they made before its first pitch or
 * action. Its lineup changes where the scorer made the change. A game that
 * ends before that side fields again writes it nowhere.
 */
function fieldsLater(
  state: GameState,
  setup: GameSetup,
  play: GamePlay,
  event: PlayEvent,
  takingField: boolean
): boolean {
  if (
    event.isSubstitution !== true ||
    !FIELDING_CHANGES.has(event.details.code)
  )
    return false
  const batting = play.about.halfInning === 'top' ? 'away' : 'home'
  if (
    playerOf(state, setup, event.player.id)?.teamId ===
    state.gameData.teams[batting].id
  )
    return true
  return (
    takingField &&
    play.playEvents.every(
      earlier => earlier.index >= event.index || earlier.isSubstitution === true
    )
  )
}

/**
 * Who the stored plays have announced, play by play. A man put in a batting
 * order is announced where he first appears in play: at bat, as a pinch
 * hitter; on a base, as a pinch runner; in the field, in the net change his
 * side writes as it takes the field. Until then he is waiting, across halves
 * if need be. One who leaves before he appears is never announced, and the
 * man who then appears in his place is announced as replacing the last man
 * who did. The lineups the game begins with announce nobody, and a man
 * still waiting when the game ends is never announced. Everything here is
 * read from the engine's plays, so an undo, a replay or a reopened game
 * announces the same.
 */
interface Cast {
  /**
   * Each player in the game who has appeared since he came in, with the man
   * he was announced replacing as a pinch hitter or runner.
   */
  appeared: Map<number, number | undefined>
  /**
   * Each player put in an order who has not appeared yet: the last man to
   * appear in the place he took, and that place.
   */
  waiting: Map<number, { replaced?: number; slot: number }>
  /** Each man a substitution took out, as he stood when he left. */
  left: Map<number, number | undefined>
  /**
   * Each man last announced as a pinch hitter or runner who has not fielded
   * since.
   */
  pinch: Map<number, 'PH' | 'PR'>
  /**
   * Each man who appeared replacing another, by the man who first held that
   * place (himself, for the men the game began with).
   */
  place: Map<number, number>
  /** The last man to appear in each such place. */
  lastIn: Map<number, number>
  /** Each side's places in the order as announced: `601`. */
  codes: Record<Side, Map<number, number>>
  seeded: boolean
}

/** Records that `id` appeared in the place of `replaced`, the last man there. */
function succeeds(cast: Cast, id: number, replaced: number | undefined): void {
  if (replaced == null) return
  const place = cast.place.get(replaced) ?? replaced
  cast.place.set(id, place)
  cast.lastIn.set(place, id)
}

/**
 * Whom a man coming in to field at the break replaces, and whether that man
 * came in to hit or run: the last man to appear in the place of the one who
 * held the position when the side last fielded, who may have left halves
 * ago; else the last man to appear in the place he took in the order (the
 * one he was sent in for, or the one who batted there then); else the
 * holder. A man still in the game is not the one leaving.
 */
function leavingFor(
  cast: Cast,
  was: SideLineup,
  now: SideLineup,
  id: number,
  holder: number | undefined
): { replaced: number | undefined; pinch?: 'PH' | 'PR' } {
  const inGame = (who: number): boolean =>
    now.battingOrder.includes(who) || Object.values(now.defense).includes(who)
  const last = (who: number | null | undefined): number | undefined =>
    who == null
      ? undefined
      : (cast.lastIn.get(cast.place.get(who) ?? who) ?? who)
  const replaced =
    [
      last(holder),
      last(cast.waiting.get(id)?.replaced),
      last(was.battingOrder[now.battingOrder.indexOf(id)])
    ].find(who => who != null && who !== id && !inGame(who)) ?? holder
  return {
    replaced,
    pinch: replaced == null ? undefined : cast.pinch.get(replaced)
  }
}

function sideOfPlayer(state: GameState, setup: GameSetup, id: number): Side {
  return sideOf(state, playerOf(state, setup, id)?.teamId)
}

/** The place in the order a lineup event names: its slot, or 0. */
function slotOf(event: PlayEvent): number {
  return event.battingOrder == null
    ? 0
    : Math.floor(Number(event.battingOrder) / 100)
}

/**
 * The place in the order of a man coming in at `slot`, as MLB writes it:
 * the slot, then how many have come in there, `602`. One coming back to a
 * place he was announced in keeps its code.
 */
function enteringCode(
  codes: Map<number, number>,
  id: number,
  slot: number
): string {
  const known = codes.get(id)
  if (known != null && Math.floor(known / 100) === slot) return String(known)
  const came = [...codes.values()]
    .filter(code => Math.floor(code / 100) === slot)
    .reduce((most, code) => Math.max(most, code % 100), 0)
  const code = slot * 100 + came + 1
  codes.set(id, code)
  return String(code)
}

/** A pinch hitter's or runner's announcement, where he first appears. */
function announce(
  state: GameState,
  setup: GameSetup,
  cast: Cast,
  id: number,
  replaced: number | undefined,
  running: boolean,
  slot: number,
  count: PlayEvent['count']
): PlayEvent {
  cast.waiting.delete(id)
  cast.appeared.set(id, replaced)
  cast.pinch.set(id, running ? 'PR' : 'PH')
  succeeds(cast, id, replaced)
  const named = (who: number): PlayerRef => ({
    id: who,
    fullName: playerOf(state, setup, who)?.fullName ?? ''
  })
  return withoutUndefined({
    index: 0,
    isPitch: false,
    type: 'action',
    details: {
      description: pinchSaid(gameNames(state, setup), running, id, replaced),
      code: 'offensive_substitution'
    },
    isSubstitution: true,
    position: running ? 'PR' : 'PH',
    battingOrder:
      slot > 0
        ? enteringCode(cast.codes[sideOfPlayer(state, setup, id)], id, slot)
        : undefined,
    replacedPlayer: replaced == null ? undefined : named(replaced),
    count: { ...count },
    player: named(id)
  })
}

/**
 * A man put in an order where the scorer made the change: announced there
 * when he appears there — the pinch hitter for the batter, the pinch runner
 * for a man on base — and otherwise waiting. A man put back in the place he
 * left before anyone appeared in it is no change.
 */
function entered(
  state: GameState,
  setup: GameSetup,
  cast: Cast,
  play: GamePlay,
  event: PlayEvent
): PlayEvent | undefined {
  const id = event.player.id
  const out = event.replacedPlayer?.id
  let replaced = out
  if (out != null) {
    const before = cast.waiting.get(out)
    if (before != null) {
      replaced = before.replaced
      cast.waiting.delete(out)
    } else if (cast.appeared.has(out)) {
      cast.left.set(out, cast.appeared.get(out))
      cast.appeared.delete(out)
    }
  }
  if (id === replaced) {
    cast.appeared.set(id, cast.left.get(id))
    return undefined
  }
  const batting = play.about.halfInning === 'top' ? 'away' : 'home'
  const running = event.position === 'PR'
  if (
    sideOfPlayer(state, setup, id) === batting &&
    (running || battersOf(play).includes(id))
  )
    return {
      ...announce(
        state,
        setup,
        cast,
        id,
        replaced,
        running,
        slotOf(event),
        event.count
      ),
      index: event.index
    }
  cast.appeared.delete(id)
  cast.waiting.set(id, { replaced, slot: slotOf(event) })
  return undefined
}

/**
 * A change to the fielders written where the scorer made it. The man it
 * puts in the field appears there, so one who had not appeared since he came
 * in is a defensive substitution even when he was already in the order.
 */
function fielded(
  state: GameState,
  setup: GameSetup,
  cast: Cast,
  event: PlayEvent
): PlayEvent {
  const id = event.player.id
  const fresh = !cast.appeared.has(id)
  if (fresh) succeeds(cast, id, cast.waiting.get(id)?.replaced)
  cast.waiting.delete(id)
  cast.appeared.set(id, cast.appeared.get(id))
  cast.pinch.delete(id)
  const codes = cast.codes[sideOfPlayer(state, setup, id)]
  const slot = slotOf(event)
  const position = POSITIONS.find(known => known === event.position)
  if (event.details.code !== 'defensive_switch') {
    if (fresh && slot > 0) enteringCode(codes, id, slot)
    return event
  }
  if (fresh && position != null) {
    const holder = event.replacedPlayer
    const who = (ref: PlayerRef): SaidPlayer =>
      saidOf(person(state, setup, ref))
    return withoutUndefined({
      ...event,
      details: {
        description: defensiveSubstitutionSaid(
          gameNames(state, setup),
          who(event.player),
          holder == null ? undefined : who(holder),
          position
        ),
        code: 'defensive_substitution'
      },
      battingOrder: slot > 0 ? enteringCode(codes, id, slot) : undefined
    })
  }
  const known = codes.get(id)
  return withoutUndefined({
    ...event,
    battingOrder:
      slot === 0
        ? undefined
        : String(
            known != null && Math.floor(known / 100) === slot
              ? known
              : slot * 100
          )
  })
}

/**
 * A change of batting order, naming only the men who have appeared: one
 * still waiting is announced where he first appears, so a reorder that moves
 * only such men is not written.
 */
function reordered(
  state: GameState,
  setup: GameSetup,
  cast: Cast,
  event: PlayEvent
): PlayEvent | undefined {
  const all = event.moved ?? []
  const moved = all.filter(({ player }) => !cast.waiting.has(player.id))
  if (moved.length === all.length) return event
  if (moved.length === 0) return undefined
  return {
    ...event,
    details: {
      ...event.details,
      description: battingOrderSaid(
        gameNames(state, setup),
        moved.map(({ player, bats }) => ({
          player: saidOf(person(state, setup, player)),
          bats
        }))
      )
    },
    moved,
    player: moved[0].player
  }
}

/**
 * What the side in the field announces at the start of the first play of
 * its half: the net change to its fielders since it last left the field —
 * as the half before began, when that half's first play opened — to its
 * first pitch or action here. Every change it made in between, at bat or at
 * the break, is folded in, so a change it undid is not written, and a man
 * who never pitched is never announced. The game's first half has nothing
 * before it: the lineups it begins with are the reference. Null when this
 * play is not the first of its half, or a play the reference needs was not
 * scored here.
 */
function takingTheField(
  state: GameState,
  plays: readonly GamePlay[],
  at: number,
  play: GamePlay,
  cast: Cast
): StoredEvent[] | null {
  if (at === 0) return null
  const last = plays[at - 1]
  if (last.about.halfInning === play.about.halfInning) return null
  let first = at - 1
  while (
    first > 0 &&
    plays[first - 1].about.halfInning === last.about.halfInning &&
    plays[first - 1].about.inning === last.about.inning
  )
    first--
  const lineups = plays[first].lineups
  const was = first === 0 ? lineups?.began : lineups?.opened
  const now = play.lineups?.began
  if (was == null || now == null) return null
  const side: Side = play.about.halfInning === 'top' ? 'home' : 'away'
  const codes = cast.codes[side]
  const changes = fieldingChanges(
    state,
    was[side],
    now[side],
    cast.appeared,
    codes,
    (id, holder) => leavingFor(cast, was[side], now[side], id, holder)
  )
  for (const change of changes) {
    const id = change.player.id
    if (!cast.appeared.has(id)) {
      const slot = now[side].battingOrder.indexOf(id) + 1
      if (slot > 0) enteringCode(codes, id, slot)
      cast.appeared.set(id, undefined)
      succeeds(cast, id, cast.waiting.get(id)?.replaced)
    }
    cast.waiting.delete(id)
    cast.pinch.delete(id)
  }
  return changes.map((change, index) =>
    withoutUndefined({
      index,
      isPitch: false,
      type: 'action',
      details: {
        description: change.description,
        code: change.eventType,
        fromPosition: change.fromPosition
      },
      isSubstitution: true,
      position: change.position,
      battingOrder: change.battingOrder,
      replacedPlayer: change.replacedPlayer,
      pinch: change.pinch,
      count: { balls: 0, strikes: 0, outs: 0 },
      player: change.player
    })
  )
}

/**
 * The engine's events a stored play keeps, and where each lands. MLB writes
 * no event for a runner the ball in play moved: his entry points at the
 * in-play pitch, as the engine's does already. The engine also writes an
 * event for each runner the scorer moves or puts out while a play is being
 * decided — the batter caught on a fly, a runner sent home on a double — and
 * those are left out, so every event after one moves up. So is a change to
 * a side's fielders that MLB announces when it takes the field
 * (`fieldsLater`), and a man put in an order who has not appeared yet
 * (`entered`). In the first play a side fields, the net of those changes
 * comes first; in a play a waiting man bats in, his announcement follows;
 * and a waiting man placed on base is announced just after he is placed.
 */
/**
 * An engine event as a stored play writes it. A defensive substitution at the
 * break also says whether the man it replaced came in to hit or to run, which
 * its sentence names and the engine's events do not carry.
 */
type StoredEvent = PlayEvent & { pinch?: 'PH' | 'PR' }

interface StoredEvents {
  /**
   * Written first: the net change the side in the field announces, and the
   * waiting man coming to bat.
   */
  carried: StoredEvent[]
  kept: PlayEvent[]
  /** Announcements written just after the kept event at an engine index. */
  after: Map<number, PlayEvent[]>
  /** The stored index of the engine's event at `index`. */
  indexOf: (index: number) => number
}

/**
 * The stored events of `play`, the game's play at `at`, with `cast` as the
 * plays before it left it; `plays` is read only before `at`.
 */
function eventsOfPlay(
  state: GameState,
  setup: GameSetup,
  plays: readonly GamePlay[],
  at: number,
  play: GamePlay,
  cast: Cast
): StoredEvents {
  const lineups = play.lineups
  if (lineups != null) {
    // The lineups the game begins with, or the first play scored here opens
    // with, announce nobody; whoever has left since is out of the game.
    const seen = cast.seeded
      ? lineups.opened
      : at === 0
        ? lineups.began
        : lineups.opened
    const present = new Set(
      (['away', 'home'] as const).flatMap(side => [
        ...seen[side].battingOrder,
        ...Object.values(seen[side].defense)
      ])
    )
    if (!cast.seeded)
      for (const id of present) if (id != null) cast.appeared.set(id, undefined)
    cast.seeded = true
    for (const id of [...cast.appeared.keys()])
      if (!present.has(id)) cast.appeared.delete(id)
    for (const id of [...cast.waiting.keys()])
      if (!present.has(id)) cast.waiting.delete(id)
  }
  const taking = takingTheField(state, plays, at, play, cast)
  const carried = [...(taking ?? [])]
  const batter = battersOf(play)[0]
  const waiting = cast.waiting.get(batter)
  if (waiting != null) {
    const batting = play.about.halfInning === 'top' ? 'away' : 'home'
    const slot =
      (lineups?.opened[batting].battingOrder.indexOf(batter) ?? -1) + 1
    const previous = at > 0 ? plays[at - 1] : undefined
    const outs =
      previous?.about.inning === play.about.inning &&
      previous.about.halfInning === play.about.halfInning
        ? previous.count.outs
        : 0
    carried.push(
      announce(
        state,
        setup,
        cast,
        batter,
        waiting.replaced,
        false,
        slot > 0 ? slot : waiting.slot,
        { balls: 0, strikes: 0, outs }
      )
    )
  }
  const kept: PlayEvent[] = []
  const after = new Map<number, PlayEvent[]>()
  for (const event of play.playEvents) {
    const linked = event.details.runnerEntry
    if (linked != null && play.runners[linked]?.details.byAction !== true)
      continue
    if (event.isSubstitution === true) {
      if (fieldsLater(state, setup, play, event, taking != null)) continue
      const code = event.details.code
      const written =
        code === 'offensive_substitution'
          ? entered(state, setup, cast, play, event)
          : FIELDING_CHANGES.has(code)
            ? fielded(state, setup, cast, event)
            : code === 'ts_batting_order'
              ? reordered(state, setup, cast, event)
              : event
      if (written != null) kept.push(written)
      continue
    }
    kept.push(event)
    const placed = cast.waiting.get(event.player.id)
    if (event.details.code === 'placed_runner' && placed != null)
      after.set(event.index, [
        announce(
          state,
          setup,
          cast,
          event.player.id,
          placed.replaced,
          true,
          placed.slot,
          event.count
        )
      ])
  }
  return {
    carried,
    kept,
    after,
    indexOf: index =>
      carried.length +
      kept
        .filter(event => event.index < index)
        .reduce(
          (count, event) => count + 1 + (after.get(event.index)?.length ?? 0),
          0
        )
  }
}

function emptyCast(): Cast {
  return {
    appeared: new Map(),
    waiting: new Map(),
    left: new Map(),
    pinch: new Map(),
    place: new Map(),
    lastIn: new Map(),
    codes: { away: new Map(), home: new Map() },
    seeded: false
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
  // The side in the field announces its changes as it takes the field,
  // before the first pitch.
  const written = events.carried.map(event =>
    substitutionDocument(event, who, scoreBefore(play))
  )
  let pitchNumber = 0
  for (const event of events.kept) {
    const made = entriesOf(play, event)
    const score = scores[event.index]
    written.push(
      event.isPitch
        ? pitchDocument(
            event,
            ++pitchNumber,
            made,
            who,
            hitDataOf(play, fenceOf(state))
          )
        : event.isSubstitution === true
          ? substitutionDocument(event, who, score)
          : event.details.code === 'ts_courtesy_runner'
            ? courtesyRunnerDocument(event, who, score)
            : actionDocument(state, setup, play, event, made, score)
    )
    for (const announced of events.after.get(event.index) ?? [])
      written.push(substitutionDocument(announced, who, score))
  }
  return written.map((event, index) => ({ ...event, index }))
}

/** The substitutions the feed writes `battingOrder` and `replacedPlayer` on. */
const ORDERED_SUBSTITUTIONS: ReadonlySet<string> = new Set([
  'offensive_substitution',
  'defensive_switch'
])

/**
 * A lineup change as the feed writes it: who came in or moved, to which
 * position, and the announcement. A pinch hitter and a defensive switch also
 * carry the player's place in the order and the player he replaced; a
 * pitching change and a defensive substitution carry neither, as in the feed.
 * A change of batting order alone is TeamStation's own `ts_batting_order`.
 * A change to a side's fielders made while it bats is written where the feed
 * writes it, as the net change at the start of the first play that side
 * fields (`takingTheField`), and a man put in the order where he first
 * appears (`Cast`).
 */
function substitutionDocument(
  event: StoredEvent,
  who: (ref: PlayerRef) => Person,
  score: Score
): Record<string, unknown> {
  const eventType = event.details.code
  const position =
    event.position == null ? undefined : GAME_POSITIONS.get(event.position)
  const ordered = ORDERED_SUBSTITUTIONS.has(eventType)
  return withoutUndefined({
    index: event.index,
    isPitch: false,
    isSubstitution: true,
    type: 'action',
    details: {
      description: event.details.description,
      event: mlbEventName(eventType),
      eventType,
      awayScore: score.away,
      homeScore: score.home,
      isScoringPlay: false,
      isOut: false,
      hasReview: false
    },
    said: substitutionSaid(event, who),
    count: { ...event.count },
    player: who(event.player),
    position: position == null ? undefined : { ...position },
    battingOrder: ordered ? event.battingOrder : undefined,
    replacedPlayer:
      ordered && event.replacedPlayer != null
        ? who(event.replacedPlayer)
        : undefined,
    startTime: null,
    endTime: null
  })
}

/**
 * What a lineup change's sentence is made from, read from the event the
 * sentence was worded for: the players it names, and the position and place
 * it names. The men a pitching change and a defensive substitution replace
 * are named here only, as the feed writes no `replacedPlayer` on them.
 */
function substitutionSaid(
  event: StoredEvent,
  who: (ref: PlayerRef) => Person
): LineupSaid | undefined {
  const player = saidOf(who(event.player))
  const replaced =
    event.replacedPlayer == null ? undefined : saidOf(who(event.replacedPlayer))
  const position = event.position as Position
  switch (event.details.code) {
    case 'pitching_substitution':
      return withoutUndefined({ kind: 'pitching' as const, player, replaced })
    case 'defensive_substitution':
      return withoutUndefined({
        kind: 'defensive' as const,
        player,
        replaced,
        position,
        pinch: event.pinch
      })
    case 'offensive_substitution':
      return withoutUndefined({
        kind: 'pinch' as const,
        player,
        replaced,
        running: event.position === 'PR'
      })
    case 'defensive_switch':
      return withoutUndefined({
        kind: 'switch' as const,
        player,
        position,
        fromPosition: event.details.fromPosition as Position | undefined
      })
    case 'ts_batting_order':
      return {
        kind: 'order',
        moved: (event.moved ?? []).map(({ player, bats }) => ({
          player: saidOf(who(player)),
          bats
        }))
      }
    default:
      return undefined
  }
}

/**
 * A pinch runner who leaves the batting order as it is: TeamStation's own
 * `ts_courtesy_runner`, naming the runner and the man he runs for. It is no
 * substitution, so it takes nobody's place in the order or on the field, and
 * it moves nobody: the runner's later entries name him.
 */
function courtesyRunnerDocument(
  event: PlayEvent,
  who: (ref: PlayerRef) => Person,
  score: Score
): Record<string, unknown> {
  return withoutUndefined({
    index: event.index,
    isPitch: false,
    type: 'action',
    details: {
      description: event.details.description,
      event: mlbEventName('ts_courtesy_runner'),
      eventType: 'ts_courtesy_runner',
      awayScore: score.away,
      homeScore: score.home,
      isScoringPlay: false,
      isOut: false,
      hasReview: false
    },
    said:
      event.replacedPlayer == null
        ? undefined
        : {
            kind: 'courtesy',
            player: saidOf(who(event.player)),
            replaced: saidOf(who(event.replacedPlayer))
          },
    count: { ...event.count },
    player: who(event.player),
    replacedPlayer:
      event.replacedPlayer == null ? undefined : who(event.replacedPlayer),
    startTime: null,
    endTime: null
  })
}

// ---- Highlight credits ----

function sideOf(state: GameState, teamId: string | undefined): Side {
  return teamId === state.gameData.teams.home.id ? 'home' : 'away'
}

/** A fielder who assisted on an out, by id, or by name for one with none. */
interface CreditAssist {
  creditUserId: number | null
  position: string
  name?: string
}

/**
 * A highlight's credit. Its label is worded from the rest: the head, the
 * person credited and his position, then the fielders who assisted, `from`
 * each in turn (`creditLabel` in `storedNames.ts`).
 */
interface HighlightCredit {
  eventType: string
  label: string
  teamId: Side
  creditUserId: number | null
  credit: { name: string; role: string; position: string | null }
  head: string
  assists: CreditAssist[]
  assistWord: 'from'
}

/**
 * Whom a highlight credits for each type of play the engine stores: the
 * batter who reached or sacrificed, the pitcher who struck him out, or the
 * fielders who made the outs. A play of a type in `nobody` credits only the
 * runners who scored or stole on it.
 */
export const HIGHLIGHT_CREDITED = {
  batter: new Set([
    'single',
    'double',
    'triple',
    'home_run',
    'walk',
    'intent_walk',
    'hit_by_pitch',
    'catcher_interf',
    'ts_manual_placement',
    'sac_fly',
    'sac_fly_double_play',
    'sac_bunt',
    'sac_bunt_double_play'
  ]),
  pitcher: new Set([
    'strikeout',
    'strikeout_double_play',
    'strikeout_triple_play'
  ]),
  fielder: new Set([
    'field_out',
    'force_out',
    'fielders_choice_out',
    'other_out',
    'ts_batter_out',
    'double_play',
    'grounded_into_double_play',
    'grounded_into_triple_play',
    'triple_play',
    'caught_stealing_2b',
    'caught_stealing_3b',
    'caught_stealing_home',
    'pickoff_1b',
    'pickoff_2b',
    'pickoff_3b',
    'pickoff_caught_stealing_2b',
    'pickoff_caught_stealing_3b',
    'pickoff_caught_stealing_home'
  ]),
  nobody: new Set([
    'fielders_choice',
    'field_error',
    'error',
    'wild_pitch',
    'passed_ball',
    'balk',
    'stolen_base_2b',
    'stolen_base_3b',
    'stolen_base_home',
    'defensive_indiff',
    'other_advance',
    'runner_placed',
    'pitching_substitution',
    'offensive_substitution',
    'defensive_substitution',
    'defensive_switch',
    'ts_batting_order',
    'ts_courtesy_runner',
    'final_score'
  ])
} as const satisfies Record<string, ReadonlySet<string>>

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
    assisted: RunnerCredit[] = []
  ): void => {
    const player = playerOf(state, setup, ref.id)
    const name = player?.fullName ?? ref.fullName
    const detail =
      assisted.length === 0
        ? ''
        : ` from ${assisted.map(c => `${c.player.fullName} (${c.position})`).join(', ')}`
    credits.push({
      eventType,
      label: `${head}: ${name}${position == null ? '' : ` (${position})`}${detail}`,
      teamId: sideOf(state, player?.teamId),
      creditUserId: player?.id ?? null,
      credit: { name, role, position },
      head,
      assists: assisted.map(c => {
        const id = playerOf(state, setup, c.player.id)?.id ?? null
        return id == null
          ? {
              creditUserId: null,
              position: c.position,
              name: c.player.fullName
            }
          : { creditUserId: id, position: c.position }
      }),
      assistWord: 'from'
    })
  }
  if (HIGHLIGHT_CREDITED.batter.has(type))
    add(play.matchup.batter, type, eventTypeName(type), 'batter')
  if (HIGHLIGHT_CREDITED.pitcher.has(type))
    add(play.matchup.pitcher, type, eventTypeName(type), 'pitcher')
  if (HIGHLIGHT_CREDITED.fielder.has(type))
    for (const runner of play.runners)
      if (runner.movement.isOut) {
        const putout = runner.credits.find(c => c.credit === 'f_putout')
        if (putout == null) continue
        const assists = runner.credits.filter(c => c.credit === 'f_assist')
        add(
          putout.player,
          type,
          runner.movement.end === 0
            ? 'Out'
            : `Out at ${runner.movement.end === 4 ? 'home' : ordinal(runner.movement.end)}`,
          'fielder',
          putout.position,
          assists
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

const HANDS = { L: 'Left', R: 'Right' } as const

/**
 * The batter, the side he stood on, and the pitcher, with the hand the
 * pitcher throws with when the roster says it.
 */
function matchupOf(
  state: GameState,
  setup: GameSetup,
  play: GamePlay
): Record<string, unknown> {
  const side = play.matchup.batSide.code
  const pitcher = play.matchup.pitcher
  const throws = (
    state.gameData.players[pitcher.id] ?? setup.players[pitcher.id]
  )?.throws
  const hand = throws == null ? null : throws === 'left' ? 'L' : 'R'
  return {
    batter: person(state, setup, play.matchup.batter),
    batSide: { code: side, description: HANDS[side] },
    pitcher: person(state, setup, pitcher),
    ...(hand == null
      ? {}
      : { pitchHand: { code: hand, description: HANDS[hand] } })
  }
}

function documentBody(
  state: GameState,
  play: GamePlay,
  stamp: PlayStamp,
  events: StoredEvents
): Record<string, unknown> {
  const setup = stamp.setupBefore
  const runners = runnersOf(state, setup, play, events)
  const playEvents = playEventsOf(state, setup, play, events)
  return {
    about: {
      atBatIndex: play.about.atBatIndex,
      inning: play.about.inning,
      halfInning: play.about.halfInning,
      isTopInning: play.about.halfInning === 'top',
      isComplete: play.about.isComplete,
      isScoringPlay: play.runners.some(scoredRunner),
      hasOut: play.runners.some(runner => runner.movement.isOut),
      hasReview: false,
      startTime: stamp.startTime ?? null,
      endTime: stamp.endTime ?? null
    },
    count: { ...play.count },
    matchup: matchupOf(state, setup, play),
    runners,
    playEvents,
    pitchIndex: playEvents
      .filter(event => event.isPitch === true)
      .map(event => event.index),
    actionIndex: playEvents
      .filter(event => event.isPitch !== true)
      .map(event => event.index),
    runnerIndex: runners.map((runner, i) => i),
    teamStation: teamStationOf(
      state.gameData.teams,
      stamp,
      play.source.teamstation
    )
  }
}

/**
 * The play's result put somebody out: an out made on the play itself, or the
 * runner's third out between pitches that ended it. A runner caught stealing
 * earlier in the plate appearance is the play's out (`hasOut`), not its
 * result's.
 */
function resultIsOut(play: GamePlay): boolean {
  const last = play.runners.at(-1)
  return (
    play.runners.some(
      runner => runner.movement.isOut && runner.details.byAction !== true
    ) ||
    (last?.details.byAction === true && last.movement.isOut)
  )
}

/** Each segment's setup without its undefined keys, cleaned once per setup. */
const cleanSetups = new WeakMap<TeamSetup, TeamSetup>()

/**
 * A play's document without its undefined keys, as `withoutUndefined` makes
 * it, except that the setup it began from, half the document and the same
 * for every play folded from its segment, is cleaned once and shared. Cleaning
 * it for every play of the game on every save took a phone about 25 ms 70
 * plate appearances in.
 */
function folded(document: Record<string, unknown>): Record<string, unknown> {
  const stamp = document.teamStation as
    { setupBefore?: TeamSetup; [key: string]: unknown } | undefined
  const setup = stamp?.setupBefore
  if (stamp == null || setup == null) return withoutUndefined(document)
  const out = withoutUndefined({
    ...document,
    teamStation: { ...stamp, setupBefore: null }
  })
  let clean = cleanSetups.get(setup)
  if (clean == null) {
    clean = withoutUndefined(setup)
    cleanSetups.set(setup, clean)
  }
  ;(out.teamStation as Record<string, unknown>).setupBefore = clean
  return out
}

/**
 * Folds a game's plays into stored plays, carrying the `Cast` from each play
 * to the next, so folding every play of a game is one pass over it rather
 * than one from the game's start for each. Each play is folded with the
 * `Cast` as the plays before it left it. Plays asked for in the game's order
 * cost one step each; asking for an earlier play starts over.
 */
export class PlayFolder {
  /** Every step any folder has taken a `Cast` through a play, for tests. */
  static steps = 0
  private cast = emptyCast()
  /** How many of the game's plays `cast` has been carried past. */
  private through = 0

  constructor(private readonly state: GameState) {}

  /**
   * A folder over `state`, a later game with the same plays so far, that
   * carries on from where this one has got to rather than walking those plays
   * again. This one is left as it was, so it can be carried on from again.
   * Its plays fold as a fresh folder's would only while `foldInputsOf` both
   * games is the same.
   */
  continuing(state: GameState): PlayFolder {
    const next = new PlayFolder(state)
    const cast = this.cast
    next.cast = {
      appeared: new Map(cast.appeared),
      waiting: new Map(cast.waiting),
      left: new Map(cast.left),
      pinch: new Map(cast.pinch),
      place: new Map(cast.place),
      lastIn: new Map(cast.lastIn),
      codes: { away: new Map(cast.codes.away), home: new Map(cast.codes.home) },
      seeded: cast.seeded
    }
    next.through = this.through
    return next
  }

  /** A completed play, ready to store. */
  play(play: GamePlay, stamp: PlayStamp): GumboPlay {
    return asGumboPlay(
      folded({
        ...this.body(play, stamp),
        result: {
          type: 'atBat',
          event: eventName(playEventType(play), play),
          eventType: playEventType(play),
          description: play.result.description,
          rbi: play.result.rbi,
          awayScore: play.result.awayScore,
          homeScore: play.result.homeScore,
          isOut: resultIsOut(play)
        },
        credits: highlightCredits(this.state, stamp.setupBefore, play)
      })
    )
  }

  /**
   * The at-bat in progress: no outcome and no score, because it has none
   * yet. When the batter due is on base there is no play, and the record
   * rides on a play that names only its place in the game.
   */
  current(play: GamePlay | null, stamp: PlayStamp): CurrentPlay {
    const state = this.state
    if (play == null) {
      const line = state.liveData.linescore
      return asCurrentPlay({
        about: {
          atBatIndex: state.liveData.plays.allPlays.length,
          inning: line.currentInning,
          halfInning: line.isTopInning ? 'top' : 'bottom',
          isTopInning: line.isTopInning,
          isComplete: false,
          hasOut: false,
          hasReview: false
        },
        teamStation: teamStationOf(state.gameData.teams, stamp)
      })
    }
    const body = this.body(play, stamp)
    return asCurrentPlay(
      folded({
        ...body,
        about: { ...(body.about as object), isComplete: false }
      })
    )
  }

  private body(play: GamePlay, stamp: PlayStamp): Record<string, unknown> {
    return documentBody(
      this.state,
      play,
      stamp,
      this.eventsOf(stamp.setupBefore, play)
    )
  }

  /** The play's stored events: the `Cast` carried up to it, then the play. */
  private eventsOf(setup: GameSetup, play: GamePlay): StoredEvents {
    const state = this.state
    const all = state.liveData.plays.allPlays
    const index = play.about.atBatIndex
    let at = all[index]?.about.atBatIndex === index ? index : -1
    if (at < 0) {
      at = all.findIndex(earlier => earlier.about.atBatIndex === index)
      if (at < 0) at = all.length
    }
    if (at < this.through) {
      this.cast = emptyCast()
      this.through = 0
    }
    for (; this.through < at; this.through++) {
      PlayFolder.steps++
      eventsOfPlay(
        state,
        setup,
        all,
        this.through,
        all[this.through],
        this.cast
      )
    }
    PlayFolder.steps++
    const events = eventsOfPlay(state, setup, all, at, play, this.cast)
    // The play is the game's play at `at`, as it stands, so the cast is now
    // carried past it; the at-bat in progress is not among them.
    this.through = at < all.length ? at + 1 : Number.POSITIVE_INFINITY
    return events
  }
}

/**
 * Everything of a game, beyond its plays, that folding one of its completed
 * plays reads: its players' names, user ids and teams, its teams and its
 * fence. A play folded from a game folds the same from a later one with the
 * same plays so far while this is the same.
 */
export function foldInputsOf(state: GameState): string {
  const { gameData } = state
  const parts = [
    String(fenceOf(state)),
    gameData.teams.away.id,
    gameData.teams.home.id
  ]
  for (const id of Object.keys(gameData.players)) {
    const player = gameData.players[Number(id)]
    parts.push(`${id}:${player.id}:${player.teamId}:${player.fullName}`)
  }
  return JSON.stringify(parts)
}

/**
 * A completed play, ready to store. Folding more than one play of a game
 * goes through one `PlayFolder`.
 */
export function documentOf(
  state: GameState,
  play: GamePlay,
  stamp: PlayStamp
): GumboPlay {
  return new PlayFolder(state).play(play, stamp)
}

/** The at-bat in progress, or the place of one whose batter is on base. */
export function currentDocumentOf(
  state: GameState,
  play: GamePlay | null,
  stamp: PlayStamp
): CurrentPlay {
  return new PlayFolder(state).current(play, stamp)
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
    teamStation: teamStationOf(state.gameData.teams, stamp)
  })
}
