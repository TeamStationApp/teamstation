import { isLaunchAngle } from '../launchAngle'
import { isPitchZone } from '../pitchData'
import {
  HIT_TRAJECTORIES,
  MOVEMENT_REASONS,
  PITCH_CODES,
  POSITION_CODES,
  STORED_EVENT_TYPES
} from './reference'

/**
 * What a stored play may hold, checked against MLB's lists in `reference.ts`
 * and the shapes of the live feed in `reference/feed776258.json`.
 *
 * Every code is on MLB's list or is one of GameStation's named extensions:
 * the event type of the result, of each runner and of each action, each
 * pitch code, each movement reason, each trajectory and each position. Every
 * runner has the feed's runner shape: the keys it carries are the feed's, and
 * each holds the feed's type of value.
 *
 * A play GameStation scored (it carries a `gameStation` record) is written
 * whole by `scoring/document.ts`, so its runners carry every key and its
 * events every detail. A play another service posted carries what that
 * service knew, so only the keys it has are held to the feed's shape.
 */

/** Which rule a stored play breaks. */
export type GumboRule =
  | 'eventType'
  | 'pitchCode'
  | 'movementReason'
  | 'runner'
  | 'credit'
  | 'position'
  | 'playEvent'
  | 'hitData'
  | 'pitchData'
  | 'trajectory'
  | 'location'
  | 'matchup'
  | 'about'

export interface GumboViolation {
  rule: GumboRule
  /** Where in the play, as `runners[0].movement.end`. */
  path: string
  message: string
}

type Kind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'

/** A key the feed writes, and the kinds of value it holds there. */
type Shape = Record<string, readonly Kind[]>

const BASES: ReadonlySet<unknown> = new Set([null, '1B', '2B', '3B'])
const ENDS: ReadonlySet<unknown> = new Set([null, '1B', '2B', '3B', 'score'])
const OUT_BASES: ReadonlySet<unknown> = new Set([null, '1B', '2B', '3B', '4B'])

/** A runner's `movement`, as every runner in the feed has it. */
const MOVEMENT: Shape = {
  originBase: ['null', 'string'],
  start: ['null', 'string'],
  end: ['null', 'string'],
  outBase: ['null', 'string'],
  isOut: ['boolean'],
  outNumber: ['null', 'number']
}

/** A runner's `details`, as every runner in the feed has them. */
const RUNNER_DETAILS: Shape = {
  event: ['string'],
  eventType: ['string'],
  movementReason: ['null', 'string'],
  runner: ['object'],
  responsiblePitcher: ['null', 'object'],
  isScoringEvent: ['boolean'],
  rbi: ['boolean'],
  earned: ['boolean'],
  teamUnearned: ['boolean'],
  playIndex: ['number']
}

/** A fielder's credit on a runner. The position is left out for a fielder not on defence. */
const CREDIT: Shape = {
  player: ['object'],
  position: ['object'],
  credit: ['string']
}
const CREDIT_REQUIRED = ['player', 'credit']

const POSITION: Shape = {
  code: ['string'],
  name: ['string'],
  type: ['string'],
  abbreviation: ['string']
}

/** A pitch's `details`, as `document.ts` writes them. */
const PITCH_DETAILS: Shape = {
  call: ['object'],
  code: ['string'],
  description: ['string'],
  isInPlay: ['boolean'],
  isStrike: ['boolean'],
  isBall: ['boolean'],
  isOut: ['boolean'],
  hasReview: ['boolean']
}

/** An action's `details`, as `document.ts` writes them. */
const ACTION_DETAILS: Shape = {
  description: ['string'],
  event: ['string'],
  eventType: ['string'],
  awayScore: ['number'],
  homeScore: ['number'],
  isScoringPlay: ['boolean'],
  isOut: ['boolean'],
  hasReview: ['boolean']
}

/**
 * Measured on the ball in the feed; GameStation only ever estimates them. Its
 * `launchAngle` is the scorer's own, set on the field, and its
 * `totalDistance` is where the scorer put the ball on a field of the game's
 * size, so neither is here.
 */
const MEASURED = ['launchSpeed', 'hardness']

const SIDES: ReadonlySet<unknown> = new Set(['L', 'R', 'S'])
const HANDS: ReadonlySet<unknown> = new Set(['L', 'R'])

function kindOf(value: unknown): Kind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const kind = typeof value
  return kind === 'string' ||
    kind === 'number' ||
    kind === 'boolean' ||
    kind === 'object'
    ? kind
    : 'null'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return kindOf(value) === 'object'
}

function show(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value)
}

/** The problems with one stored play, or an at-bat in progress; none when it is Gumbo. */
export function gumboViolations(play: unknown): GumboViolation[] {
  const found: GumboViolation[] = []
  const add = (rule: GumboRule, path: string, message: string): void => {
    found.push({ rule, path, message })
  }

  /** Holds `value` to `shape`: known keys, their kinds, and all of them when `whole`. */
  const shaped = (
    rule: GumboRule,
    path: string,
    value: unknown,
    shape: Shape,
    required: readonly string[] | null,
    closed: boolean
  ): value is Record<string, unknown> => {
    if (!isRecord(value)) {
      add(rule, path, `expected an object, got ${show(value)}`)
      return false
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      const kinds = shape[key]
      if (kinds == null) {
        if (closed) add(rule, `${path}.${key}`, 'is not a key Gumbo writes')
      } else if (!kinds.includes(kindOf(item)))
        add(
          rule,
          `${path}.${key}`,
          `expected ${kinds.join(' or ')}, got ${show(item)}`
        )
    }
    for (const key of required ?? [])
      if (value[key] === undefined) add(rule, `${path}.${key}`, 'is missing')
    return true
  }

  const listed = (path: string, value: unknown): void => {
    if (typeof value !== 'string' || !STORED_EVENT_TYPES.has(value))
      add('eventType', path, `${show(value)} is not a listed event type`)
  }

  const position = (path: string, value: unknown): void => {
    if (!shaped('position', path, value, POSITION, Object.keys(POSITION), true))
      return
    if (typeof value.code === 'string' && !POSITION_CODES.has(value.code))
      add('position', `${path}.code`, `${show(value.code)} is not a position`)
  }

  if (!isRecord(play)) {
    add('about', '', `expected a play, got ${show(play)}`)
    return found
  }
  const whole = play.gameStation !== undefined

  const about = play.about
  if (isRecord(about) && about.halfOuts !== undefined) {
    const outs = about.halfOuts
    if (typeof outs !== 'number' || !Number.isInteger(outs) || outs < 0)
      add('about', 'about.halfOuts', `expected a count, got ${show(outs)}`)
  }

  if (isRecord(play.result)) listed('result.eventType', play.result.eventType)

  if (play.hitData !== undefined)
    add('hitData', 'hitData', 'is written on the in-play pitch, not the play')

  const matchup = play.matchup
  if (isRecord(matchup)) {
    for (const [key, codes] of [
      ['batSide', SIDES],
      ['pitchHand', HANDS]
    ] as const) {
      if (matchup[key] === undefined) continue
      const side = matchup[key]
      if (!isRecord(side) || !codes.has(side.code))
        add('matchup', `matchup.${key}`, `${show(side)} is not a side`)
    }
  }

  const runners = play.runners
  if (runners !== undefined && !Array.isArray(runners))
    add('runner', 'runners', `expected a list, got ${show(runners)}`)
  for (const [i, runner] of (Array.isArray(runners) ? runners : []).entries()) {
    const at = `runners[${i}]`
    if (!isRecord(runner)) {
      add('runner', at, `expected a runner, got ${show(runner)}`)
      continue
    }
    for (const key of Object.keys(runner))
      if (key !== 'movement' && key !== 'details' && key !== 'credits')
        add('runner', `${at}.${key}`, 'is not a key Gumbo writes')
    const required = (shape: Shape): readonly string[] | null =>
      whole ? Object.keys(shape) : null

    const movement = runner.movement
    if (
      (whole || movement !== undefined) &&
      shaped(
        'runner',
        `${at}.movement`,
        movement,
        MOVEMENT,
        required(MOVEMENT),
        true
      )
    ) {
      for (const [key, bases] of [
        ['originBase', BASES],
        ['start', BASES],
        ['end', ENDS],
        ['outBase', OUT_BASES]
      ] as const)
        if (typeof movement[key] === 'string' && !bases.has(movement[key]))
          add(
            'runner',
            `${at}.movement.${key}`,
            `${show(movement[key])} is not a base`
          )
    }

    const details = runner.details
    if (
      (whole || details !== undefined) &&
      shaped(
        'runner',
        `${at}.details`,
        details,
        RUNNER_DETAILS,
        required(RUNNER_DETAILS),
        true
      )
    ) {
      if (details.eventType !== undefined)
        listed(`${at}.details.eventType`, details.eventType)
      const reason = details.movementReason
      if (
        reason != null &&
        (typeof reason !== 'string' || !MOVEMENT_REASONS.has(reason))
      )
        add(
          'movementReason',
          `${at}.details.movementReason`,
          `${show(reason)} is not a movement reason`
        )
    }

    const credits = runner.credits
    if (credits === undefined && !whole) continue
    if (!Array.isArray(credits)) {
      add('credit', `${at}.credits`, `expected a list, got ${show(credits)}`)
      continue
    }
    for (const [j, credit] of credits.entries()) {
      const path = `${at}.credits[${j}]`
      if (
        shaped('credit', path, credit, CREDIT, CREDIT_REQUIRED, true) &&
        credit.position !== undefined
      )
        position(`${path}.position`, credit.position)
    }
  }

  const events = play.playEvents
  if (events !== undefined && !Array.isArray(events))
    add('playEvent', 'playEvents', `expected a list, got ${show(events)}`)
  for (const [i, event] of (Array.isArray(events) ? events : []).entries()) {
    const at = `playEvents[${i}]`
    if (!isRecord(event)) {
      add('playEvent', at, `expected an event, got ${show(event)}`)
      continue
    }
    const type = event.type
    if (type !== 'pitch' && type !== 'action' && type !== 'pickoff') {
      add('playEvent', `${at}.type`, `${show(type)} is not an event type`)
      continue
    }
    if (event.isPitch !== (type === 'pitch'))
      add('playEvent', `${at}.isPitch`, `${show(event.isPitch)} on a ${type}`)
    if (event.position !== undefined) position(`${at}.position`, event.position)
    const details = event.details
    if (type === 'pitch') {
      if (
        !shaped(
          'playEvent',
          `${at}.details`,
          details,
          PITCH_DETAILS,
          whole ? Object.keys(PITCH_DETAILS) : null,
          false
        )
      )
        continue
      // A call that is not an object is already named by its shape.
      const call = details.call
      for (const [path, code] of [
        [`${at}.details.code`, details.code],
        ...(isRecord(call) ? [[`${at}.details.call.code`, call.code]] : [])
      ] as Array<[string, unknown]>)
        if (typeof code !== 'string' || !PITCH_CODES.has(code))
          add('pitchCode', path, `${show(code)} is not a pitch code`)
      if (event.hitData !== undefined) {
        if (details.isInPlay !== true)
          add('hitData', `${at}.hitData`, 'is on a pitch not in play')
        hitData(`${at}.hitData`, event.hitData)
      }
      if (event.pitchData !== undefined)
        pitchData(`${at}.pitchData`, event.pitchData)
    } else if (type === 'action') {
      if (
        shaped(
          'playEvent',
          `${at}.details`,
          details,
          ACTION_DETAILS,
          whole ? Object.keys(ACTION_DETAILS) : null,
          false
        )
      )
        listed(`${at}.details.eventType`, details.eventType)
      if (event.hitData !== undefined)
        add('hitData', `${at}.hitData`, 'is on an action, not a pitch')
    }
    if (type !== 'pitch' && event.pitchData !== undefined)
      add('pitchData', `${at}.pitchData`, `is on a ${type}, not a pitch`)
  }

  /**
   * A pitch's speed and zone. Everything else the feed writes there is
   * measured, so a play GameStation scored carries none of it.
   */
  function pitchData(path: string, value: unknown): void {
    if (!isRecord(value)) {
      add('pitchData', path, `expected an object, got ${show(value)}`)
      return
    }
    const { startSpeed, zone } = value
    if (
      startSpeed !== undefined &&
      (typeof startSpeed !== 'number' ||
        !Number.isFinite(startSpeed) ||
        startSpeed <= 0)
    )
      add(
        'pitchData',
        `${path}.startSpeed`,
        `expected mph, more than none, got ${show(startSpeed)}`
      )
    if (zone !== undefined && !isPitchZone(zone))
      add(
        'pitchData',
        `${path}.zone`,
        `expected a zone 1-9 or 11-14, got ${show(zone)}`
      )
    if (whole)
      for (const key of Object.keys(value))
        if (key !== 'startSpeed' && key !== 'zone')
          add('pitchData', `${path}.${key}`, 'is measured, never scored')
  }

  function hitData(path: string, value: unknown): void {
    if (!isRecord(value)) {
      add('hitData', path, `expected an object, got ${show(value)}`)
      return
    }
    const { trajectory, location, coordinates, launchAngle, totalDistance } =
      value
    if (launchAngle !== undefined && !isLaunchAngle(launchAngle))
      add(
        'hitData',
        `${path}.launchAngle`,
        `expected degrees from -90 to 90, got ${show(launchAngle)}`
      )
    if (
      totalDistance !== undefined &&
      (typeof totalDistance !== 'number' ||
        !Number.isFinite(totalDistance) ||
        totalDistance <= 0)
    )
      add(
        'hitData',
        `${path}.totalDistance`,
        `expected feet, more than none, got ${show(totalDistance)}`
      )
    if (
      trajectory !== undefined &&
      (typeof trajectory !== 'string' || !HIT_TRAJECTORIES.has(trajectory))
    )
      add(
        'trajectory',
        `${path}.trajectory`,
        `${show(trajectory)} is not a trajectory`
      )
    // One fielder's position, or two for a ball between them (`78`).
    if (
      location !== undefined &&
      (typeof location !== 'string' ||
        !/^[1-9]{1,2}$/.test(location) ||
        location.split('').some(code => !POSITION_CODES.has(code)))
    )
      add('location', `${path}.location`, `${show(location)} is not a location`)
    if (
      coordinates !== undefined &&
      (!isRecord(coordinates) ||
        typeof coordinates.coordX !== 'number' ||
        typeof coordinates.coordY !== 'number')
    )
      add(
        'hitData',
        `${path}.coordinates`,
        `expected {coordX, coordY}, got ${show(coordinates)}`
      )
    if (whole)
      for (const key of MEASURED)
        if (value[key] !== undefined)
          add('hitData', `${path}.${key}`, 'is an estimate, kept in the record')
  }

  return found
}
