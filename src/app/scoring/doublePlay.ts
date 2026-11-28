import { canField, DID_NOT_TAG_UP } from '../../common/scoring/rules'
import type { Position } from '../../common/scoring/state'
import { fieldingLocation } from '../field/fieldingLocation'
import { BASES, type GroundPoint, tagBaseAt } from '../field/fieldModel'
import { lstrings } from '../locales/strings'
import { fieldPlayersFor, withStandIns } from './fieldAdapter'
import type { ChainRunner } from './runnerChain'
import {
  accepted,
  act,
  beginDefense,
  forceOutEdit,
  settleRunners,
  throwToDefender
} from './scoringFlow'
import { baseIds, fielderName, playSettled } from './scoringSelectors'
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

/**
 * Plays out the rest of a ground double play once its trajectory is in, on
 * the working state and with no step of its own, so the whole relay comes off
 * with the trajectory's Undo step. The first number's fielder throws to the
 * second number's at 2nd, who forces the runner from 1st there and throws to
 * the first baseman, who retires the batter: the same actions, credits and
 * stored play as the scorer's hand relay. Each throw waits for the one before
 * it to be drawn. Runners the ground out moved from 2nd and 3rd then answer
 * Safe, Out or Back together, before the play can close.
 */
export function continueDoublePlay(next: ScoringState): void {
  const doublePlay = next.pendingPlay?.doublePlay
  if (doublePlay == null) return
  if (doublePlay.kind === 'caught') {
    doubleOff(next)
    return
  }
  for (let hop = 0; hop < 8 && next.presentation == null; hop++) {
    if (!relayStep(next, doublePlay.kind)) break
    // A throw drawn straight after the last one, with nothing scored between,
    // would take its name: the field draws each name once.
    const drawn = next.presentation as ScoringState['presentation']
    if (drawn != null) {
      doublePlay.throws = (doublePlay.throws ?? 0) + 1
      drawn.id = `${drawn.id}:relay${doublePlay.throws}`
    }
  }
}

/** One step of the assumed relay; false when there is nothing to do now. */
function relayStep(next: ScoringState, kind: DoublePlayKind): boolean {
  const pending = next.pendingPlay!
  const doublePlay = pending.doublePlay!
  const action = next.runnerAction
  const game = next.session
  if (
    next.phase === 'chooseDefender' &&
    action?.purpose === 'batterRetirement'
  ) {
    const [fielded, pivot] = doublePlayPositions(kind).map(position =>
      playerAt(next, position)
    )
    const route = action.defensiveRoute ?? []
    const holder = route.at(-1)?.id
    const first = game.pending?.originalBases[0]
    const lead = game.pending?.movements.find(move => move.playerId === first)
    if (first == null || lead == null) return false
    const forced = lead.decision === 'out'
    if (!forced && route.length === 1 && holder === fielded) {
      throwToDefender(next, pivot, { ...BASES[2] })
      return true
    }
    if (!forced && holder === pivot) {
      forceOutEdit(next, first, 2)
      return true
    }
    if (forced && holder === pivot) {
      throwToDefender(next, playerAt(next, '1B'), { ...BASES[1] })
      return true
    }
    if (forced && holder === playerAt(next, '1B')) {
      throwToDefender(next, undefined)
      return true
    }
    return false
  }
  const batter = game.liveData.plays.currentPlay?.matchup.batter.id
  if (
    doublePlay.chained === true ||
    game.pending?.movements.some(
      move => move.playerId === batter && move.decision === 'out'
    ) !== true
  )
    return false
  // The batter is out: the runners the ground out moved answer together.
  doublePlay.chained = true
  const out = new Set(
    game.pending.movements
      .filter(move => move.decision === 'out')
      .map(move => move.playerId)
  )
  const pushed: ChainRunner[] = []
  for (const from of [2, 3]) {
    const id = game.pending.originalBases[from - 1]
    if (id != null && !out.has(id))
      pushed.push({ playerId: id, from, to: from + 1 })
  }
  if (pushed.length === 0 || game.liveData.linescore.outs >= 3) return false
  next.runnerChain = { pushed }
  next.correctionWindow = null
  next.runnerAction = null
  next.phase = 'runnerMovement'
  settleRunners(next)
  return false
}

/** The baseman who takes a throw at 1st or 3rd. */
const BASEMAN: Readonly<Record<number, Position>> = { 1: '1B', 3: '3B' }

/**
 * A Caught out, once the catch is in and drawn: the runner who did not tag
 * is doubled off. One on 1st or 3rd is put out by the catcher's throw to
 * that base's baseman, or by the baseman's own tag when he made the catch;
 * one on 2nd waits for the scorer to tap who took the throw there, or Done
 * for the catcher's own tag, and the first throw's arrival makes the out.
 * With several runners on, the scorer drags whoever tagged a base to it
 * (`tagBase`). It is the trajectory's own step, so Undo takes it back with
 * the catch.
 */
function doubleOff(next: ScoringState): void {
  const doublePlay = next.pendingPlay!.doublePlay!
  const game = next.session
  if (
    doublePlay.doubled === true ||
    next.presentation != null ||
    next.pendingPlay?.trajectoryAccepted !== true ||
    game.pending?.outcome !== 'Ball Caught' ||
    game.liveData.linescore.outs >= 3
  )
    return
  const occupied = baseIds(game).flatMap((id, index) =>
    id == null ? [] : [{ id, base: index + 1 }]
  )
  if (occupied.length === 0) return
  doublePlay.doubled = true
  next.correctionWindow = null
  if (occupied.length > 1) {
    next.runnerAction = null
    next.phase = 'tagBase'
    return
  }
  const [{ id, base }] = occupied
  doubleOffAt(
    next,
    id,
    base,
    base === 2 ? undefined : playerAt(next, BASEMAN[base])
  )
}

/**
 * Puts the runner on `base` out for not tagging up, from the fielder who
 * made the catch: by his own tag when `tagger` is he, by a throw to `tagger`
 * at that base otherwise, or with no `tagger` waiting for the scorer to say
 * who took the throw. Either way one throw, or the tag, makes the out.
 */
function doubleOffAt(
  next: ScoringState,
  runner: number,
  base: number,
  tagger: FielderRef | undefined
): void {
  next.runnerAction = {
    playerId: runner,
    from: base,
    to: base,
    origin: 'current',
    returnPhase: 'correctionWindow',
    decision: 'out',
    reason: DID_NOT_TAG_UP,
    // The first throw's arrival is the out: nobody is asked for after it.
    throwOut: true
  }
  beginDefense(next)
  if (tagger == null) return
  const catcher = next.runnerAction.thrower
  if (tagger === catcher) throwToDefender(next, undefined)
  else throwToDefender(next, tagger, { ...BASES[base] })
}

/**
 * In `tagBase`, the scorer dropped defender `id` at `point`: on a base with
 * a runner, that runner is doubled off there, by the catcher's own tag when
 * `id` made the catch and by the catcher's throw to `id` otherwise, as one
 * step. A drop on no such base changes nothing.
 */
export function tagBase(
  state: ScoringState,
  id: FielderRef,
  point: GroundPoint,
  generation: number
): ScoringState {
  const ids = baseIds(state.session)
  const bases = ids.flatMap((runner, index) =>
    runner == null ? [] : [index + 1]
  )
  const base = tagBaseAt(point, bases)
  if (
    state.phase !== 'tagBase' ||
    state.presentation != null ||
    generation !== state.generation ||
    base == null ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.z) ||
    !canField(state.session.liveData.linescore.defense, id)
  )
    return state
  const runner = ids[base - 1]!
  return accepted(
    state,
    `${TAG_LABEL[base]()} ${fielderName(state.session, id)}`,
    next => {
      doubleOffAt(next, runner, base, id)
    }
  )
}

const TAG_LABEL: Readonly<Record<number, () => string>> = {
  1: () => lstrings.scoring_tag_first,
  2: () => lstrings.scoring_tag_second,
  3: () => lstrings.scoring_tag_third
}
