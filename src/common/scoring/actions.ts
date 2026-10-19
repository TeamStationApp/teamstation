import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from '../asLiteral'
import { PITCH_DATA_CLEANERS, PITCH_DATA_TOOL_FIELDS } from './pitchLocation'
import { idOfWrittenTag, positionSaid, tagOf, writtenTag } from './playerTags'
import {
  asGameSetup,
  asSessionId,
  type GameState,
  type Optional,
  type PlayerRef,
  POSITIONS,
  type Side,
  withoutUndefined
} from './state'
import { DICTATION_TERMS } from './vocabulary'

/**
 * The middle ground between whoever watched the game and the rules that score
 * it. Each action is something a witness saw — a pitch, a ball in play, a
 * runner's fate — and never something the rules derive from the rest of the
 * game: no out count, no score, no RBI, no at-bat index, no base state.
 *
 * Every list below is the single source for its values: the cleaners check
 * against it, `toolSchema()` offers it to a dictation model, and the types are
 * taken from it.
 */

export const PITCH_CALLS = ['B', 'C', 'S', 'F', 'T', 'L'] as const
export type PitchCall = (typeof PITCH_CALLS)[number]
export const PITCH_CALL_NAMES: Record<PitchCall, string> = {
  B: 'Ball',
  C: 'Called Strike',
  S: 'Swing and Miss',
  F: 'Foul Ball',
  T: 'Foul Tip',
  L: 'Foul Bunt'
}

export const CONTACTS = ['swing', 'bunt'] as const
export type Contact = (typeof CONTACTS)[number]

export const TRAJECTORIES = [
  'ground_ball',
  'line_drive',
  'fly_ball',
  'popup',
  'chopper'
] as const
/** Where a ball in play went, across the outfield from left to right. */
export const DIRECTIONS = [
  'left',
  'left_center',
  'center',
  'right_center',
  'right'
] as const
export type Direction = (typeof DIRECTIONS)[number]
export type Trajectory = (typeof TRAJECTORIES)[number]

export const HOME_RUN_KINDS = ['out-of-park', 'in-park'] as const

/** What the plate appearance came to, in Gumbo's event types. */
export const RESULT_TYPES = [
  'single',
  'double',
  'triple',
  'home_run',
  'field_error',
  'fielders_choice',
  'field_out',
  'strikeout',
  'hit_by_pitch',
  'intent_walk',
  'catcher_interference',
  'manual_placement',
  'other_out'
] as const
export type ResultType = (typeof RESULT_TYPES)[number]

/** How a batter was put out on a ball in play. */
export const OUT_KINDS = ['throw', 'catch', 'interference'] as const
export type OutKind = (typeof OUT_KINDS)[number]

export const BASES = ['1B', '2B', '3B'] as const
export type Base = (typeof BASES)[number]
/** Where a runner ended up. `batter` is the batter's box, `home` is home plate. */
export const DESTINATIONS = ['batter', '1B', '2B', '3B', 'home'] as const
export type Destination = (typeof DESTINATIONS)[number]

/** Why a runner moved, or was put out, when nothing else on the play says. */
export const RUNNER_REASONS = [
  'Advance',
  'Back',
  'Steal',
  'Wild Pitch',
  'Passed Ball',
  'Throwing Error',
  'Fielding Error',
  'Defensive Indifference',
  'Caught Stealing',
  'Force Out',
  'Picked Off',
  'Offensive Interference',
  'Out on Appeal',
  'Safe from Pickoff',
  'Safe at home',
  'Out at home',
  'Throw Out',
  'Ball Caught',
  'Batter Interference',
  'Batter Out — Other',
  'Other'
] as const
export type RunnerReason = (typeof RUNNER_REASONS)[number]

export const BASE_RUNNING_KINDS = [
  'steal',
  'caught_stealing',
  'pickoff',
  'pickoff_safe',
  'defensive_indifference'
] as const
export type BaseRunningKind = (typeof BASE_RUNNING_KINDS)[number]

export const BATTERY_KINDS = ['wild_pitch', 'passed_ball', 'balk'] as const
export type BatteryKind = (typeof BATTERY_KINDS)[number]

export const ERROR_KINDS = ['fielding', 'throwing'] as const
export type ErrorKind = (typeof ERROR_KINDS)[number]

export const LINEUP_KINDS = [
  'roster',
  'battingOrder',
  'position',
  'addPlayer',
  'substitute',
  'pinchRunner',
  'batterSide',
  'runner'
] as const
export type LineupKind = (typeof LINEUP_KINDS)[number]

export const GAME_FLOW_KINDS = [
  'closePlay',
  'endHalf',
  'placeRunner',
  'endGame',
  'override'
] as const
export type GameFlowKind = (typeof GAME_FLOW_KINDS)[number]

/**
 * Every event type a play folded from these actions can carry, in the
 * engine's own names (`document.ts` translates the three it names otherwise):
 * the results, what a closed play is refined to, the plays a runner's third
 * out ends between pitches, what runners do on their own, the lineup changes,
 * and the end of the game.
 */
export const PRODUCED_EVENT_TYPES = [
  ...RESULT_TYPES,
  'walk',
  'strikeout_double_play',
  'strikeout_triple_play',
  'force_out',
  'fielders_choice_out',
  'sac_fly',
  'sac_fly_double_play',
  'sac_bunt',
  'sac_bunt_double_play',
  'double_play',
  'triple_play',
  'grounded_into_double_play',
  'grounded_into_triple_play',
  'caught_stealing_2b',
  'caught_stealing_3b',
  'caught_stealing_home',
  'pickoff_1b',
  'pickoff_2b',
  'pickoff_3b',
  'pickoff_caught_stealing_2b',
  'pickoff_caught_stealing_3b',
  'pickoff_caught_stealing_home',
  'stolen_base_2b',
  'stolen_base_3b',
  'stolen_base_home',
  'defensive_indiff',
  'wild_pitch',
  'passed_ball',
  'balk',
  'error',
  'other_advance',
  'placed_runner',
  'pitching_substitution',
  'offensive_substitution',
  'defensive_substitution',
  'defensive_switch',
  'ts_batting_order',
  'ts_courtesy_runner',
  'final_score'
] as const

export const ACTION_TYPES = [
  'pitch',
  'ballInPlay',
  'result',
  'fieldingPlay',
  'runnerMovement',
  'baseRunning',
  'batteryEvent',
  'lineup',
  'gameFlow'
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

const asPoint = asObject({ x: asNumber, z: asNumber })
const asSideName = asLiteral('away', 'home')
const asPosition = asLiteral(...POSITIONS)
const asOneOf = <T extends string>(values: readonly T[]): Cleaner<T> =>
  asLiteral(...values)

const actionCleaners = {
  pitch: asObject({
    type: asLiteral('pitch'),
    call: asOneOf(PITCH_CALLS),
    ...PITCH_DATA_CLEANERS
  }),
  ballInPlay: asObject({
    type: asLiteral('ballInPlay'),
    contact: asOneOf(CONTACTS),
    trajectory: asOptional(asOneOf(TRAJECTORIES)),
    launchAngle: asOptional(asNumber),
    /**
     * The scorer set the launch angle himself on the field, so it is his own
     * and the stored play gives it as the ball's `launchAngle`. Dictation
     * cannot say it: `dictatedAction` drops it, and a spoken angle stays an
     * estimate.
     */
    launchAngleDragged: asOptional(asBoolean),
    location: asOptional(asPoint),
    fielder: asOptional(asSessionId),
    direction: asOptional(asOneOf(DIRECTIONS)),
    landingHeight: asOptional(asNumber),
    homeRunKind: asOptional(asOneOf(HOME_RUN_KINDS)),
    ...PITCH_DATA_CLEANERS
  }),
  result: asObject({
    type: asLiteral('result'),
    eventType: asOneOf(RESULT_TYPES),
    outBy: asOptional(asOneOf(OUT_KINDS)),
    base: asOptional(asOneOf(BASES)),
    foulCaught: asOptional(asBoolean)
  }),
  fieldingPlay: asObject({
    type: asLiteral('fieldingPlay'),
    fielders: asArray(asSessionId),
    error: asOptional(asSessionId),
    errorKind: asOptional(asOneOf(ERROR_KINDS)),
    locations: asOptional(asArray(asPoint))
  }),
  runnerMovement: asObject({
    type: asLiteral('runnerMovement'),
    runner: asSessionId,
    to: asOneOf(DESTINATIONS),
    out: asOptional(asBoolean),
    reason: asOptional(asOneOf(RUNNER_REASONS)),
    error: asOptional(asSessionId),
    errorEvent: asOptional(asNumber),
    fielders: asOptional(asArray(asSessionId)),
    locations: asOptional(asArray(asPoint)),
    runnerLocation: asOptional(asPoint),
    fieldingRoute: asOptional(
      asArray(asObject({ id: asSessionId, point: asPoint }))
    )
  }),
  baseRunning: asObject({
    type: asLiteral('baseRunning'),
    kind: asOneOf(BASE_RUNNING_KINDS),
    runner: asSessionId,
    to: asOptional(asOneOf(DESTINATIONS)),
    fielders: asOptional(asArray(asSessionId))
  }),
  batteryEvent: asObject({
    type: asLiteral('batteryEvent'),
    kind: asOneOf(BATTERY_KINDS),
    advances: asOptional(
      asArray(asObject({ runner: asSessionId, to: asOneOf(DESTINATIONS) }))
    )
  }),
  lineup: asObject({
    type: asLiteral('lineup'),
    kind: asOneOf(LINEUP_KINDS),
    side: asOptional(asSideName),
    setup: asOptional(asGameSetup),
    /**
     * Sides of a roster setup left in roster order because the saver could
     * not see that team's default. The game shows that order, and the first
     * pitch leaves that team's default as it stands.
     */
    unseen: asOptional(asArray(asSideName)),
    /**
     * Sides of a roster setup the saver could see. The first pitch takes
     * one as the lineup the game begins with, except a side an earlier save
     * left unseen whose arrangement is still that roster order.
     */
    confirmed: asOptional(asArray(asSideName)),
    /**
     * The screen logged this roster because it was showing a default in
     * place of an unseen order, ahead of a play. A rebase lets it replace
     * only a side that is still that order. Every other side stays as the
     * server holds it.
     */
    shown: asOptional(asLiteral(true)),
    nextBatter: asOptional(asSessionId),
    order: asOptional(asArray(asSessionId)),
    position: asOptional(asPosition),
    player: asOptional(asSessionId),
    replaces: asOptional(asSessionId),
    base: asOptional(asOneOf(BASES)),
    name: asOptional(asString),
    jersey: asOptional(asString),
    batSide: asOptional(asLiteral('L', 'R'))
  }),
  gameFlow: asObject({
    type: asLiteral('gameFlow'),
    kind: asOneOf(GAME_FLOW_KINDS),
    runner: asOptional(asSessionId),
    base: asOptional(asOneOf(BASES)),
    inning: asOptional(asNumber),
    top: asOptional(asBoolean),
    awayScore: asOptional(asNumber),
    homeScore: asOptional(asNumber),
    balls: asOptional(asNumber),
    strikes: asOptional(asNumber),
    outs: asOptional(asNumber),
    batter: asOptional(asSessionId),
    pitcher: asOptional(asSessionId),
    bases: asOptional(
      asArray((raw: unknown) => (raw == null ? null : asSessionId(raw)))
    )
  })
} satisfies Record<ActionType, Cleaner<unknown>>

type ActionOf<K extends ActionType> = Optional<
  ReturnType<(typeof actionCleaners)[K]>
>
export type PitchAction = ActionOf<'pitch'>
export type BallInPlayAction = ActionOf<'ballInPlay'>
export type ResultAction = ActionOf<'result'>
export type FieldingPlayAction = ActionOf<'fieldingPlay'>
export type RunnerMovementAction = ActionOf<'runnerMovement'>
export type BaseRunningAction = ActionOf<'baseRunning'>
export type BatteryEventAction = ActionOf<'batteryEvent'>
export type LineupAction = ActionOf<'lineup'>
export type GameFlowAction = ActionOf<'gameFlow'>
export type ScoringAction =
  | PitchAction
  | BallInPlayAction
  | ResultAction
  | FieldingPlayAction
  | RunnerMovementAction
  | BaseRunningAction
  | BatteryEventAction
  | LineupAction
  | GameFlowAction

export interface Problem {
  code:
    | 'unknownAction'
    | 'malformed'
    | 'notNow'
    | 'illegal'
    | 'unknownPlayer'
    | 'gameOver'
  message: string
}

/** Checks one action, or says why it is not one. Never throws. */
export function cleanAction(
  raw: unknown
): { action: ScoringAction } | { problem: Problem } {
  const type =
    raw != null && typeof raw === 'object'
      ? (raw as { type?: unknown }).type
      : undefined
  if (
    typeof type !== 'string' ||
    !(ACTION_TYPES as readonly string[]).includes(type)
  )
    return {
      problem: {
        code: 'unknownAction',
        message: `Unknown action ${JSON.stringify(type ?? null)}`
      }
    }
  try {
    return {
      action: withoutUndefined(
        actionCleaners[type as ActionType](raw)
      ) as ScoringAction
    }
  } catch (error) {
    return {
      problem: {
        code: 'malformed',
        message: `${type}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}

/**
 * Checks the action a dictation model called for: a tool's name and its
 * input, as `toolSchema()` offers them. Only the scoring screen says the
 * scorer set a launch angle himself, so a dictated ball in play loses
 * `launchAngleDragged`, whatever the model sent: its angle stays an estimate.
 */
export function dictatedAction(
  name: string,
  input: unknown
): { action: ScoringAction } | { problem: Problem } {
  const cleaned = cleanAction(
    input != null && typeof input === 'object'
      ? { ...input, type: name }
      : { type: name }
  )
  if ('problem' in cleaned || cleaned.action.type !== 'ballInPlay')
    return cleaned
  const { launchAngleDragged, ...action } = cleaned.action
  return { action }
}

/** The fields of an action that name one player, and those that name several. */
const PLAYER_FIELDS = [
  'fielder',
  'error',
  'runner',
  'nextBatter',
  'player',
  'replaces',
  'batter',
  'pitcher'
]
const PLAYERS_FIELDS = ['fielders', 'order', 'bases']

/**
 * Each player an action names, through `each`, field by field: a runner of a
 * battery event's advances too. A null among `bases` is an empty base.
 */
function mapPlayers(
  raw: Record<string, unknown>,
  each: (value: unknown, field: string) => unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  for (const field of PLAYER_FIELDS)
    if (out[field] != null) out[field] = each(out[field], field)
  for (const field of PLAYERS_FIELDS)
    if (Array.isArray(out[field]))
      out[field] = (out[field] as unknown[]).map(value =>
        value == null ? value : each(value, field)
      )
  if (Array.isArray(out.advances))
    out.advances = out.advances.map((advance: unknown) =>
      advance != null && typeof advance === 'object'
        ? mapPlayers(advance as Record<string, unknown>, each)
        : advance
    )
  return out
}

/** The fields of an action that name a fielder: his tag, or his position. */
const FIELDER_FIELDS = ['fielder', 'error', 'fielders']

/** What a dictated action is to the scorer, for a call left out. */
const SAID_ACTIONS: Readonly<Record<string, string>> = {
  pitch: 'the pitch',
  ballInPlay: 'the ball in play',
  result: 'the result',
  fieldingPlay: 'the error',
  runnerMovement: "the runner's move",
  baseRunning: "the runner's play",
  steal: 'the steal',
  caught_stealing: 'the caught stealing',
  pickoff: 'the pickoff',
  pickoff_safe: 'the pickoff throw',
  defensive_indifference: "the runner's advance",
  batteryEvent: 'the wild pitch, passed ball or balk',
  wild_pitch: 'the wild pitch',
  passed_ball: 'the passed ball',
  balk: 'the balk',
  lineup: 'the lineup change',
  gameFlow: 'the game change'
}

/** Who a player field names, to the scorer. */
const SAID_FIELDS: Readonly<Record<string, string>> = {
  fielder: 'the fielder',
  error: 'the fielder charged with the error',
  fielders: 'a fielder',
  runner: 'the runner',
  nextBatter: 'the next batter',
  player: 'the player',
  replaces: 'the player leaving',
  batter: 'the batter',
  pitcher: 'the pitcher',
  order: 'a batter in the order',
  bases: 'a runner on base'
}

/**
 * A dictated action with its players' tags read back as their ids, before it
 * is cleaned. A model names a player only by a tag `game` gives, and a
 * fielder by his tag or by the position `fielding` gives him (`LF`, "the left
 * fielder"): anything else — a tag of nobody in the game, a number, a
 * position for a runner, or a whole setup (which names players by id) — is a
 * problem, never a guess. A problem says, as the scorer reads it, what was
 * left out and why, and never repeats a tag.
 */
export function untaggedAction(
  raw: Record<string, unknown> & { type: string },
  game: ReadonlySet<number>,
  fielding: ReadonlyMap<string, number> = new Map()
): { raw: Record<string, unknown> } | { problem: Problem } {
  // No action at all: the cleaner says so.
  if (!(ACTION_TYPES as readonly string[]).includes(raw.type)) return { raw }
  const kind = typeof raw.kind === 'string' ? SAID_ACTIONS[raw.kind] : undefined
  const what =
    raw.type === 'baseRunning' || raw.type === 'batteryEvent'
      ? (kind ?? SAID_ACTIONS[raw.type])
      : SAID_ACTIONS[raw.type]
  if (raw.setup != null)
    return {
      problem: {
        code: 'malformed',
        message: `${what} — a whole game setup is never dictated`
      }
    }
  let unknown: { value: unknown; field: string } | undefined
  const untagged = mapPlayers(raw, (value, field) => {
    const said = typeof value === 'string' ? value : undefined
    let id = said == null ? undefined : idOfWrittenTag(said)
    if (id == null && said != null && FIELDER_FIELDS.includes(field)) {
      const position = positionSaid(said)
      id = position == null ? undefined : fielding.get(position)
    }
    if (id != null && game.has(id)) return id
    unknown ??= { value, field }
    return value
  })
  if (unknown == null) return { raw: untagged }
  const who = SAID_FIELDS[unknown.field]
  const { value } = unknown
  // A tag, which the scorer never reads, is not repeated to him.
  const shown =
    (typeof value === 'string' &&
      value.trim() !== '' &&
      idOfWrittenTag(value) == null) ||
    typeof value === 'number'
      ? ` ${JSON.stringify(value)}`
      : ''
  return {
    problem: {
      code: 'unknownPlayer',
      message: `${what} — ${who}${shown} is no player in the game`
    }
  }
}

/** An action as a model reads it back: each player by his tag. */
export function taggedAction(action: ScoringAction): Record<string, unknown> {
  return mapPlayers(action, value =>
    typeof value === 'number' ? tagOf(value) : value
  )
}

export function destinationBase(to: Destination): number {
  return DESTINATIONS.indexOf(to)
}
export function baseDestination(base: number): Destination {
  return DESTINATIONS[Math.max(0, Math.min(4, base))]
}

export interface JsonSchema {
  type?: string
  enum?: readonly unknown[]
  anyOf?: JsonSchema[]
  minimum?: number
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  description?: string
  additionalProperties?: boolean
}
export interface Tool {
  name: ActionType
  description: string
  input_schema: JsonSchema
}

// A player by his tag (`playerTags.ts`), never a number: a model handed
// players by number sent a jersey or a base for one.
const TAG =
  "the player's tag from GAME, like KT4; never a jersey or base number"
const id = (description: string): JsonSchema => ({
  type: 'string',
  description: `${description}: ${TAG}`
})
const ids = (description: string): JsonSchema => ({
  type: 'array',
  items: { type: 'string' },
  description: `${description}: each ${TAG}`
})
const oneOf = (values: readonly string[], description: string): JsonSchema => ({
  type: 'string',
  enum: values,
  description
})
const point: JsonSchema = {
  type: 'object',
  properties: { x: { type: 'number' }, z: { type: 'number' } },
  required: ['x', 'z']
}
function tool(
  name: ActionType,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[] = []
): Tool {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    }
  }
}

/**
 * One tool per action, for a dictation model to call. Every enum comes from
 * the list the cleaners check against. The tool's input is the action without
 * its `type`, which is the tool's name.
 */
export function toolSchema(): Tool[] {
  return [
    tool(
      'pitch',
      'A pitch that was not put in play.',
      {
        call: oneOf(
          PITCH_CALLS,
          'B ball, C called strike, S swinging strike, F foul, T foul tip, L foul bunt'
        ),
        ...PITCH_DATA_TOOL_FIELDS
      },
      ['call']
    ),
    tool(
      'ballInPlay',
      'The batter put the ball in play. Follow it with a result.',
      {
        contact: oneOf(CONTACTS, 'A full swing or a bunt'),
        trajectory: oneOf(TRAJECTORIES, 'How the ball left the bat'),
        launchAngle: { type: 'number', description: 'Degrees, when known' },
        location: point,
        fielder: id('The fielder who first handled the ball'),
        direction: oneOf(
          DIRECTIONS,
          'Where the ball went when the scorer says: left, left center, center, right center or right field'
        ),
        homeRunKind: oneOf(HOME_RUN_KINDS, 'For a home run'),
        landingHeight: { type: 'number' },
        ...PITCH_DATA_TOOL_FIELDS
      },
      ['contact']
    ),
    tool(
      'result',
      'What the plate appearance came to. strikeout here means a dropped third strike only — strike three the catcher did not hold — and is refused unless there are two strikes and first base is empty or two out. An ordinary strikeout is the pitch that makes strike three, and a walk is the pitch that makes ball four; the game records both from the pitch.',
      {
        eventType: oneOf(RESULT_TYPES, 'The outcome'),
        outBy: oneOf(
          OUT_KINDS,
          'For field_out: thrown out, caught, or interference'
        ),
        base: oneOf(BASES, 'For manual_placement: where the batter was put'),
        foulCaught: { type: 'boolean', description: 'A caught foul ball' }
      },
      ['eventType']
    ),
    tool(
      'fieldingPlay',
      'Charges an error, and is refused at any other time: only after a result of field_error, name the fielders who handled the ball in order and the one charged. It does not record who fielded a hit or made a throw — ballInPlay names the fielder, and runnerMovement names the fielders of a putout.',
      {
        fielders: ids('Fielders in the order they handled the ball'),
        error: id('The fielder charged with an error'),
        errorKind: oneOf(ERROR_KINDS, 'Fielding or throwing error'),
        locations: { type: 'array', items: point }
      },
      ['fielders', 'error']
    ),
    tool(
      'runnerMovement',
      "A runner's fate: safe at a base, or out. A hit already moves the batter and every runner forward by its bases — a double, two — and a caught ball already retires the batter; naming a runner where the play already put him is refused. Use it for what the play did not do: a runner who stopped short, went further, or was put out; a runner the hit sent home, to say he scored (to home) or was out there; and the batter when he was thrown or tagged out, to credit the fielders.",
      {
        runner: id('The runner'),
        to: oneOf(DESTINATIONS, 'Where the runner ended up or was put out'),
        out: { type: 'boolean', description: 'The runner was put out' },
        reason: oneOf(RUNNER_REASONS, 'Why'),
        fielders: ids(
          'For an out: the fielders who handled the ball, last one made the putout'
        ),
        locations: { type: 'array', items: point },
        runnerLocation: point
      },
      ['runner', 'to']
    ),
    tool(
      'baseRunning',
      'A runner acted on his own between pitches.',
      {
        kind: oneOf(BASE_RUNNING_KINDS, 'What the runner did'),
        runner: id('The runner'),
        to: oneOf(
          DESTINATIONS,
          'The base he went for; for a pickoff, the base he was picked off at'
        ),
        fielders: ids('For an out: the fielders involved, putout last')
      },
      ['kind', 'runner']
    ),
    tool(
      'batteryEvent',
      'A wild pitch, a passed ball or a balk, and where each runner went.',
      {
        kind: oneOf(BATTERY_KINDS, 'What happened'),
        advances: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              runner: id('The runner'),
              to: { type: 'string', enum: DESTINATIONS }
            },
            required: ['runner', 'to']
          }
        }
      },
      ['kind']
    ),
    tool(
      'lineup',
      'A change to a batting order, a position, or the players in the game. A pinch runner is kind pinchRunner: the side at bat, the base of the runner he runs for, and the player coming in, who takes that base.',
      {
        kind: oneOf(
          LINEUP_KINDS,
          'What changed: substitute puts player in for replaces; pinchRunner puts player on base in place of the runner there; runner does the same and leaves the batting order as it is'
        ),
        side: oneOf(['away', 'home'], 'Which team'),
        order: ids('For battingOrder: the whole order'),
        position: oneOf(POSITIONS, 'For position and substitute'),
        player: id('The player placed, added or brought in'),
        replaces: id('For substitute: the player leaving'),
        base: oneOf(
          BASES,
          'For pinchRunner and runner: the base of the runner he runs for'
        ),
        name: { type: 'string', description: 'For addPlayer' },
        jersey: { type: 'string', description: 'For addPlayer' },
        batSide: oneOf(['L', 'R'], 'For batterSide')
      },
      ['kind']
    ),
    tool(
      'gameFlow',
      'Close the play, end the half inning or the game, place a runner, or correct the game state.',
      {
        kind: oneOf(GAME_FLOW_KINDS, 'What to do'),
        runner: id('For placeRunner'),
        base: oneOf(BASES, 'For placeRunner')
      },
      ['kind']
    )
  ]
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/**
 * How a player is named to a model: first name and last initial, the way a
 * scorer says it. A full surname belongs to a child and is never put in front
 * of a model — neither the LLM nor the recogniser.
 */
export function shortName(player: {
  fullName: string
  firstName?: string
  lastName?: string
}): string {
  const first = player.firstName?.trim() ?? ''
  const last = player.lastName?.trim() ?? ''
  if (first !== '' && last !== '') return `${first} ${initial(last)}`
  const words = player.fullName
    .trim()
    .split(/\s+/)
    .filter(word => word !== '')
  if (words.length === 0) return first
  if (words.length === 1) return words[0]
  return `${words.slice(0, -1).join(' ')} ${initial(words[words.length - 1])}`
}
function initial(word: string): string {
  const letter = word.replace(/^[^\p{L}\p{N}]+/u, '').charAt(0)
  return letter === '' ? '' : `${letter.toUpperCase()}.`
}

/** Who bats after the batter now up, for a sentence about two batters. */
function nextBatter(state: GameState): PlayerRef | null {
  const line = state.liveData.linescore
  const order =
    state.liveData.boxscore.teams[line.isTopInning ? 'away' : 'home']
      .battingOrder
  const now = line.offense.batter?.id
  if (now == null || order.length === 0) return null
  const id = order[(order.indexOf(now) + 1) % order.length]
  const player = state.gameData.players[id]
  return player == null ? null : { id, fullName: player.fullName }
}

/**
 * What a model is told before it hears the scorer: the situation, and who is
 * where, by short name with the tag the model must use (`playerTags.ts`),
 * never his id. It names no score and no at-bat index, because the model must
 * never echo those back.
 */
export function promptContext(state: GameState): string {
  const line = state.liveData.linescore
  const players = state.gameData.players
  // A scorer names a player by first name or by the number on the shirt.
  const name = (ref: PlayerRef | null): string => {
    if (ref == null) return 'nobody'
    const player = players[ref.id]
    const jersey = player?.jersey.trim() ?? ''
    return `${shortName(player ?? ref)}${jersey === '' ? '' : ` #${jersey}`} ${writtenTag(ref.id)}`
  }
  const batting = line.isTopInning ? 'away' : 'home'
  const fielding = batting === 'away' ? 'home' : 'away'
  const lines = [
    `${line.isTopInning ? 'Top' : 'Bottom'} of the ${ordinal(line.currentInning)}, ${line.outs} ${line.outs === 1 ? 'out' : 'outs'}, count ${line.balls}-${line.strikes}.`,
    `${state.gameData.teams[batting].name} batting, ${state.gameData.teams[fielding].name} in the field.`,
    `Batter: ${name(line.offense.batter)}. Pitcher: ${name(line.defense.P)}.`,
    `On first: ${name(line.offense.first)}. On second: ${name(line.offense.second)}. On third: ${name(line.offense.third)}.`,
    `Next batter: ${name(nextBatter(state))}.`,
    `Fielders: ${POSITIONS.map(position => `${position} ${name(line.defense[position])}`).join(', ')}.`
  ]
  return lines.join('\n')
}

/**
 * What the recogniser is biased toward for the at-bat the game is on, in
 * priority order: the batter, the pitcher and the runners — who a scorer is
 * about to name — then the fielders, then everyone else on both rosters, then
 * the two team names, then `DICTATION_TERMS`. Names are short names. No term
 * is empty or longer than the recogniser's 50 characters, and none repeats.
 * The recogniser takes at most 100, and the order is what the caller truncates.
 *
 * A coach passes his side. The list is then that roster only — the players
 * of his who are in the at-bat first, then the rest of his roster — then his
 * team's name, then the same scoring words.
 */
export function keyterms(state: GameState, side?: Side): string[] {
  const line = state.liveData.linescore
  const players = state.gameData.players
  const boxscore = state.liveData.boxscore.teams
  const roster =
    side == null
      ? [...boxscore.away.players, ...boxscore.home.players]
      : boxscore[side].players
  const his = new Set(roster)
  const live: Array<PlayerRef | null | number> = [
    line.offense.batter,
    line.defense.P,
    line.offense.first,
    line.offense.second,
    line.offense.third,
    ...POSITIONS.map(position => line.defense[position])
  ]
  const refs = [
    ...live.filter(ref => {
      if (ref == null || side == null) return true
      const id = typeof ref === 'number' ? ref : ref.id
      return his.has(id)
    }),
    ...roster
  ]
  const out: string[] = []
  const seen = new Set<string>()
  const add = (term: string): void => {
    const trimmed = term.trim()
    const key = trimmed.toLowerCase()
    if (trimmed === '' || trimmed.length > 50 || seen.has(key)) return
    seen.add(key)
    out.push(trimmed)
  }
  for (const ref of refs) {
    if (ref == null) continue
    const id = typeof ref === 'number' ? ref : ref.id
    const player = players[id] ?? (typeof ref === 'number' ? undefined : ref)
    if (player != null) add(shortName(player))
  }
  if (side == null) {
    add(state.gameData.teams.away.name)
    add(state.gameData.teams.home.name)
  } else add(state.gameData.teams[side].name)
  for (const term of DICTATION_TERMS) add(term)
  return out
}
