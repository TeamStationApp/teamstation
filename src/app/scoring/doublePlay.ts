import type { Position } from '../../common/scoring/state'
import { fieldingLocation } from '../field/fieldingLocation'
import { lstrings } from '../locales/strings'
import { fieldPlayersFor, withStandIns } from './fieldAdapter'
import { accepted, act } from './scoringFlow'
import { baseIds, playSettled } from './scoringSelectors'
import type { FielderRef, ScoringState } from './scoringTypes'

/**
 * The More menu's Double Play: six ground-ball double plays, named by the
 * scorer's numbers (the fielder who played it, the baseman at 2nd, and so
 * on), and a runner caught off base after a catch (`caught`, "Did not
 * tag"). Choosing one starts the ball in play the scorer would otherwise
 * start from Ball in Play: a ground kind with its fielder assumed, at his
 * position, and the trajectory to drag; `caught` as a Ball Caught.
 */
export const DOUBLE_PLAYS = [
  '6-4-3',
  '4-6-3',
  '5-4-3',
  '3-6-3',
  '1-6-3',
  '1-4-3',
  'caught'
] as const
export type DoublePlayKind = (typeof DOUBLE_PLAYS)[number]

/** The position each scorer's number stands for. */
const NUMBERED: Readonly<Record<string, Position>> = {
  '1': 'P',
  '2': 'C',
  '3': '1B',
  '4': '2B',
  '5': '3B',
  '6': 'SS'
}

/** The positions a ground kind's numbers name, in the order the ball goes. */
export function doublePlayPositions(kind: DoublePlayKind): Position[] {
  if (kind === 'caught') return []
  return kind.split('-').map(number => NUMBERED[number])
}

/** The rows the menu shows now: none with two outs or the bases empty. */
export function doublePlayChoices(state: ScoringState): DoublePlayKind[] {
  const { session } = state
  const line = session.liveData.linescore
  if (
    session.final ||
    !playSettled(state) ||
    line.outs >= 2 ||
    line.offense.batter == null ||
    session.liveData.plays.currentPlay == null
  )
    return []
  const [first, second, third] = baseIds(session).map(id => id != null)
  return DOUBLE_PLAYS.filter(kind =>
    kind === 'caught' ? first || second || third : first
  )
}

/** The Double Play submenu's rows that apply now; Caught out says how. */
export function doublePlayRows(
  state: ScoringState
): Array<{ key: DoublePlayKind; label: string; subtext?: string }> {
  return doublePlayChoices(state).map(kind =>
    kind === 'caught'
      ? {
          key: kind,
          label: lstrings.scoring_caught_out,
          subtext: lstrings.scoring_did_not_tag
        }
      : { key: kind, label: kind }
  )
}

/** Who plays `position` for the defense, or the stand-in there. */
function playerAt(state: ScoringState, position: Position): FielderRef {
  return state.session.liveData.linescore.defense[position]?.id ?? position
}

/**
 * Starts the Double Play `kind` as one Undo step: the ball in play, then a
 * ground kind's fielder, assumed at his position holding the ball, and the
 * trajectory to drag; `caught` the fielder to place, as a Ball Caught.
 */
export function startDoublePlay(
  state: ScoringState,
  kind: DoublePlayKind
): ScoringState {
  if (!doublePlayChoices(state).includes(kind)) return state
  const label =
    kind === 'caught' ? 'Double Play: caught out' : `Double Play ${kind}`
  return accepted(state, label, next => {
    act(next, { type: 'ballInPlay', contact: 'swing' })
    if (kind === 'caught') {
      next.pendingPlay = {
        outcome: 'Ball Caught',
        contactKind: 'swing',
        trajectoryAccepted: false,
        doublePlay: { kind }
      }
      next.phase = 'locateFielder'
      return
    }
    const fielder = playerAt(next, doublePlayPositions(kind)[0])
    const standing = withStandIns(fieldPlayersFor(next.session), next.session, [
      fielder
    ]).find(player =>
      typeof fielder === 'number'
        ? player.playerId === fielder
        : player.standIn === fielder
    )
    next.pendingPlay = {
      outcome: 'Ground Out',
      contactKind: 'swing',
      trajectoryAccepted: false,
      doublePlay: { kind },
      fielder,
      ...(standing == null
        ? {}
        : { location: fieldingLocation('Ground Out', standing.position) }),
      angle: 45
    }
    next.phase = 'trajectory'
  })
}
