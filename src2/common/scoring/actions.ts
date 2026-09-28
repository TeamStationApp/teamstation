import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
  type Cleaner
} from 'cleaners'

import {
  asGameSetup,
  asSessionId,
  type GameState,
  type Optional,
  type PlayerRef,
  POSITIONS,
  withoutUndefined
} from './state'

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
  'batterSide'
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
  'gs_batting_order',
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
const asSideName = asValue('away' as const, 'home' as const)
const asPosition = asValue(...POSITIONS)
const asOneOf = <T extends string>(values: readonly T[]): Cleaner<T> =>
  asValue(...values)

const actionCleaners = {
  pitch: asObject({
    type: asValue('pitch' as const),
    call: asOneOf(PITCH_CALLS),
    zone: asOptional(asNumber)
  }),
  ballInPlay: asObject({
    type: asValue('ballInPlay' as const),
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
    landingHeight: asOptional(asNumber),
    homeRunKind: asOptional(asOneOf(HOME_RUN_KINDS))
  }),
  result: asObject({
    type: asValue('result' as const),
    eventType: asOneOf(RESULT_TYPES),
    outBy: asOptional(asOneOf(OUT_KINDS)),
    base: asOptional(asOneOf(BASES)),
    foulCaught: asOptional(asBoolean)
  }),
  fieldingPlay: asObject({
    type: asValue('fieldingPlay' as const),
    fielders: asArray(asSessionId),
    error: asOptional(asSessionId),
    errorKind: asOptional(asOneOf(ERROR_KINDS)),
    locations: asOptional(asArray(asPoint))
  }),
  runnerMovement: asObject({
    type: asValue('runnerMovement' as const),
    runner: asSessionId,
    to: asOneOf(DESTINATIONS),
    out: asOptional(asBoolean),
    reason: asOptional(asOneOf(RUNNER_REASONS)),
    fielders: asOptional(asArray(asSessionId)),
    locations: asOptional(asArray(asPoint)),
    runnerLocation: asOptional(asPoint)
  }),
  baseRunning: asObject({
    type: asValue('baseRunning' as const),
    kind: asOneOf(BASE_RUNNING_KINDS),
    runner: asSessionId,
    to: asOptional(asOneOf(DESTINATIONS)),
    fielders: asOptional(asArray(asSessionId))
  }),
  batteryEvent: asObject({
    type: asValue('batteryEvent' as const),
    kind: asOneOf(BATTERY_KINDS),
    advances: asOptional(
      asArray(asObject({ runner: asSessionId, to: asOneOf(DESTINATIONS) }))
    )
  }),
  lineup: asObject({
    type: asValue('lineup' as const),
    kind: asOneOf(LINEUP_KINDS),
    side: asOptional(asSideName),
    setup: asOptional(asGameSetup),
    nextBatter: asOptional(asSessionId),
    order: asOptional(asArray(asSessionId)),
    position: asOptional(asPosition),
    player: asOptional(asSessionId),
    replaces: asOptional(asSessionId),
    base: asOptional(asOneOf(BASES)),
    name: asOptional(asString),
    jersey: asOptional(asString),
    batSide: asOptional(asValue('L' as const, 'R' as const))
  }),
  gameFlow: asObject({
    type: asValue('gameFlow' as const),
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

export function destinationBase(to: Destination): number {
  return DESTINATIONS.indexOf(to)
}
export function baseDestination(base: number): Destination {
  return DESTINATIONS[Math.max(0, Math.min(4, base))]
}

interface JsonSchema {
  type?: string
  enum?: readonly unknown[]
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

const id = (description: string): JsonSchema => ({
  type: 'integer',
  description
})
const ids = (description: string): JsonSchema => ({
  type: 'array',
  items: { type: 'integer' },
  description
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
        zone: { type: 'integer', description: 'MLB zone 1-14, when said' }
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
        homeRunKind: oneOf(HOME_RUN_KINDS, 'For a home run'),
        landingHeight: { type: 'number' }
      },
      ['contact']
    ),
    tool(
      'result',
      'What the plate appearance came to.',
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
      'The fielders who handled the ball, in order, and who made an error.',
      {
        fielders: ids('Fielders in the order they handled the ball'),
        error: id('The fielder charged with an error'),
        errorKind: oneOf(ERROR_KINDS, 'Fielding or throwing error'),
        locations: { type: 'array', items: point }
      },
      ['fielders']
    ),
    tool(
      'runnerMovement',
      "A runner's fate: safe at a base, or out.",
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
        to: oneOf(DESTINATIONS, 'The base he went for'),
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
              runner: { type: 'integer' },
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
          'What changed: substitute puts player in for replaces; pinchRunner puts player on base in place of the runner there'
        ),
        side: oneOf(['away', 'home'], 'Which team'),
        order: ids('For battingOrder: the whole order'),
        position: oneOf(POSITIONS, 'For position and substitute'),
        player: id('The player placed, added or brought in'),
        replaces: id('For substitute: the player leaving'),
        base: oneOf(
          BASES,
          'For pinchRunner: the base of the runner he runs for'
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
 * What a model is told before it hears the scorer: the situation, and who is
 * where, by name with the id the model must use. It names no score and no
 * at-bat index, because the model must never echo those back.
 */
export function promptContext(state: GameState): string {
  const line = state.liveData.linescore
  const players = state.gameData.players
  const name = (ref: PlayerRef | null): string =>
    ref == null
      ? 'nobody'
      : `${players[ref.id]?.fullName ?? ref.fullName} (id ${ref.id})`
  const batting = line.isTopInning ? 'away' : 'home'
  const fielding = batting === 'away' ? 'home' : 'away'
  const lines = [
    `${line.isTopInning ? 'Top' : 'Bottom'} of the ${ordinal(line.currentInning)}, ${line.outs} ${line.outs === 1 ? 'out' : 'outs'}, count ${line.balls}-${line.strikes}.`,
    `${state.gameData.teams[batting].name} batting, ${state.gameData.teams[fielding].name} in the field.`,
    `Batter: ${name(line.offense.batter)}. Pitcher: ${name(line.defense.P)}.`,
    `On first: ${name(line.offense.first)}. On second: ${name(line.offense.second)}. On third: ${name(line.offense.third)}.`,
    `Fielders: ${POSITIONS.map(position => `${position} ${name(line.defense[position])}`).join(', ')}.`
  ]
  return lines.join('\n')
}
