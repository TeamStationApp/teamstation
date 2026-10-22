import type {
  Direction,
  PitchAction,
  ResultAction
} from '../../common/scoring/actions'
import type { Depth } from '../../common/scoring/depth'
import {
  fenceOf,
  type GameState,
  type Position,
  POSITIONS
} from '../../common/scoring/state'
import { BASES, DIRT_EDGE, type GroundPoint } from '../field/fieldModel'
import { OUTFIELD_RADIUS } from '../field/stadiumBoundary'

/**
 * Where a dictated ball went, made up for a sentence that says only which
 * way: a spot on the field for its stored coordinates and its animation. It
 * credits nobody.
 */

/** Degrees from straight away; left is the third-base side, x negative. */
export const SPRAY: Record<Direction, number> = {
  left: -30,
  left_center: -15,
  center: 0,
  right_center: 15,
  right: 30
}
/** Feet-free field units from the plate. */
const HIT_DEPTH: Partial<Record<ResultAction['eventType'], number>> = {
  single: 62,
  double: 95,
  triple: 105,
  // Beyond the fence.
  home_run: 125
}
const CAUGHT_DEPTH = 72
const GROUNDED_DEPTH = 35
const OTHER_DEPTH = 60
/** Foul territory is past 45°; a caught foul is placed at 55°. */
export const FOUL_ANGLE = 55
/** A ball to a base runs just inside its line: first base is 43°. */
export const BASE_BEARING = { first: 43, second: 0, third: -43 } as const
export type BaseName = keyof typeof BASE_BEARING
/** From the plate to first or third, in field units. */
const BASE_DISTANCE = Math.hypot(BASES[1].x, BASES[1].z)

/** Field units a distance in feet is, at a game with this fence. */
export function unitsOfFeet(feet: number, fenceFt: number): number {
  return (feet * OUTFIELD_RADIUS) / fenceFt
}

/**
 * How far from the plate a ball at this depth came to, in field units, at a
 * game whose fence is `fenceFt` away. The field is drawn one size, so fixed
 * landmarks are fixed units; a depth said in feet past one ("10 feet past
 * the infield", "10 feet short of the wall") is converted at this fence, and
 * kept between its neighbours however small or large the fence.
 */
export function depthUnits(depth: Depth, fenceFt: number): number {
  const feet = (ft: number): number => unitsOfFeet(ft, fenceFt)
  const between = (units: number, low: number, high: number): number =>
    units > low && units < high ? units : (low + high) / 2
  switch (depth) {
    case 'shy_of_base':
      return BASE_DISTANCE * 0.85
    case 'dribbler':
      return 24
    case 'infield':
      return 38
    case 'past_base':
      return BASE_DISTANCE + feet(15)
    case 'bloop':
      return between(DIRT_EDGE + feet(10), 38, 65)
    case 'shallow':
      return 65
    case 'medium':
      return 82
    case 'deep':
      return 105
    case 'warning_track':
      return between(OUTFIELD_RADIUS - feet(10), 105, OUTFIELD_RADIUS)
    case 'wall':
      return OUTFIELD_RADIUS
  }
}

/** The ground point this many units out on this bearing, in degrees. */
export function depthPoint(degrees: number, units: number): GroundPoint {
  return at(degrees, units)
}

/** The bearing from the plate to a point, in degrees from straight away. */
export function bearingOf(point: GroundPoint): number {
  return (Math.atan2(point.x, -point.z) * 180) / Math.PI
}

function at(degrees: number, depth: number): GroundPoint {
  const radians = (degrees * Math.PI) / 180
  return {
    x: Math.round(Math.sin(radians) * depth * 100) / 100,
    z: Math.round(-Math.cos(radians) * depth * 100) / 100
  }
}

/** The spot a ball sent this way came to, at a depth for the play. */
export function directionPoint(
  direction: Direction,
  result: ResultAction | undefined,
  grounded: boolean
): GroundPoint {
  const hit = result == null ? undefined : HIT_DEPTH[result.eventType]
  const depth =
    hit ??
    (grounded
      ? GROUNDED_DEPTH
      : result?.eventType === 'field_out' && result.outBy === 'catch'
        ? CAUGHT_DEPTH
        : OTHER_DEPTH)
  return at(SPRAY[direction], depth)
}

/** A fielder's position in the field, from the game's defense. */
export function positionOf(
  game: GameState,
  fielder: number
): Position | undefined {
  const defense = game.liveData.linescore.defense
  return POSITIONS.find(position => defense[position]?.id === fielder)
}

const FIRST_SIDE: readonly Position[] = ['1B', '2B', 'RF']
const THIRD_SIDE: readonly Position[] = ['3B', 'SS', 'LF']

/**
 * The side of the field a foul went to: the named fielder's, or with none
 * — or one straight away — the side away from the batter: first-base side
 * (+1) for a right-handed batter, third-base side (−1) for a left-handed one.
 */
export function foulSide(game: GameState, fielder?: number): 1 | -1 {
  const position = fielder == null ? undefined : positionOf(game, fielder)
  if (position != null && FIRST_SIDE.includes(position)) return 1
  if (position != null && THIRD_SIDE.includes(position)) return -1
  const bats = game.liveData.plays.currentPlay?.matchup.batSide.code
  return bats === 'L' ? -1 : 1
}

/** Who catches a foul nobody named: the corner infielder on its side. */
export function foulFielder(game: GameState): number | undefined {
  const defense = game.liveData.linescore.defense
  return (foulSide(game) === 1 ? defense['1B'] : defense['3B'])?.id
}

/**
 * Where a caught foul came down: in foul territory on its side, as deep as
 * the fielder plays; a catcher's behind the plate.
 */
export function foulPoint(game: GameState, fielder?: number): GroundPoint {
  const side = foulSide(game, fielder)
  const position = fielder == null ? undefined : positionOf(game, fielder)
  if (position === 'C') return { x: side * 3, z: 5 }
  const depth =
    position === 'LF' || position === 'CF' || position === 'RF' ? 70 : 28
  return at(side * FOUL_ANGLE, depth)
}

/**
 * Where an uncaught foul the scorer placed came down: on its side, at its
 * depth (past the base when he gave only the side). A foul he did not place
 * has no spot, and is drawn as every foul is.
 */
export function foulPlace(
  game: GameState,
  pitch: PitchAction
): GroundPoint | undefined {
  if (pitch.call !== 'F' || (pitch.depth == null && pitch.direction == null))
    return undefined
  const side =
    pitch.direction === 'left'
      ? -1
      : pitch.direction === 'right'
        ? 1
        : foulSide(game)
  return depthPoint(
    side * FOUL_ANGLE,
    depthUnits(pitch.depth ?? 'past_base', fenceOf(game))
  )
}
