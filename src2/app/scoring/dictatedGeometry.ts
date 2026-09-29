import type { Direction, ResultAction } from '../../common/scoring/actions'
import {
  type GameState,
  type Position,
  POSITIONS
} from '../../common/scoring/state'
import type { GroundPoint } from '../field/fieldModel'

/**
 * Where a dictated ball went, made up for a sentence that says only which
 * way: a spot on the field for its stored coordinates and its animation. It
 * credits nobody.
 */

/** Degrees from straight away; left is the third-base side, x negative. */
const SPRAY: Record<Direction, number> = {
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
const FOUL_ANGLE = 55

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
