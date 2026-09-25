import type { Transition } from '../../common/scoring/transitions'
import {
  BASES,
  clampToField,
  type FieldPlayer,
  type GroundPoint
} from '../field/fieldModel'
import { fieldPlayersFor } from './fieldAdapter'
import { copyState } from './scoringMachine'
import { battingSide } from './scoringSelectors'
import type { ScoringSnapshot, ScoringState } from './scoringTypes'

/**
 * How the screen moves runners: the paths they take, where they wait to hear
 * whether they were safe at home, and the walk to the dugout. The game has
 * already happened by the time any of this runs; it only shows it.
 */

/** Where the runners headed home wait their turn, lead runner nearest. */
export function homeQueuePoint(index: number): GroundPoint {
  const distance = 1.2 + index * 0.61
  return { x: -distance / Math.SQRT2, z: -distance / Math.SQRT2 }
}
export function basePath(from: number, to: number): GroundPoint[] {
  const points = [{ ...BASES[from % 4] }]
  for (let base = from + 1; base <= Math.min(4, to); base++)
    points.push({ ...BASES[base % 4] })
  if (to < from)
    for (let base = from - 1; base >= to; base--)
      points.push({ ...BASES[base % 4] })
  return points
}
type Moving = Pick<
  ScoringSnapshot,
  'motions' | 'generation' | 'session' | 'pendingPlay' | 'runnerAction'
>
export function enqueue(
  state: Moving,
  id: number,
  waypoints: GroundPoint[]
): void {
  state.motions = state.motions.filter(motion => motion.playerId !== id)
  state.motions.push({
    id: `${state.generation}:${state.session.meta.sequence}:${id}:${state.motions.length}`,
    generation: state.generation,
    playerId: id,
    waypoints: copyState(waypoints),
    complete: waypoints.length < 2
  })
}
export function approachFirst(
  state: Moving,
  id: number,
  start: GroundPoint,
  end: GroundPoint
): void {
  enqueue(state, id, [start, end])
  const motion = state.motions.find(m => m.playerId === id)
  if (motion != null) motion.purpose = 'approachFirst'
}
function dugoutPoint(state: Moving): GroundPoint {
  return { x: battingSide(state.session) === 'home' ? 32 : -32, z: 6 }
}
function dugout(state: Moving, id: number, origin: GroundPoint): void {
  enqueue(state, id, [origin, dugoutPoint(state)])
}
function endsInDugout(state: Moving, id: number, side: GroundPoint): boolean {
  const last = state.motions.find(m => m.playerId === id)?.waypoints.at(-1)
  return last?.x === side.x && last.z === side.z
}

/**
 * The motions for what an action did. `before` is the game as it stood before
 * the action, whose home queue and batter say where each runner starts from;
 * `batSide` is the side the batter stood on.
 */
export function sequencesFor(
  state: Moving,
  transitions: readonly Transition[],
  before: {
    homeQueue: readonly number[]
    batSide: 'L' | 'R'
    battingSide: 'away' | 'home'
  }
): void {
  const side = { x: before.battingSide === 'home' ? 32 : -32, z: 6 }
  let queue = [...before.homeQueue]
  const after = state.session.homeQueue
  for (const transition of transitions) {
    if (transition.type === 'runnerMoved') {
      const path = basePath(transition.from, transition.to)
      if (transition.from === 0)
        path[0] = { x: before.batSide === 'L' ? 4 : -4, z: 0 }
      if (transition.pendingHome) {
        queue = [...after]
        path[path.length - 1] = homeQueuePoint(
          Math.max(0, after.indexOf(transition.runner))
        )
      }
      if (transition.automaticHome) {
        if (after.length > 0)
          path[path.length - 1] = homeQueuePoint(after.length)
        else path.push(side)
      }
      enqueue(state, transition.runner, path)
    } else if (transition.type === 'runnerReturned') {
      const index = queue.indexOf(transition.runner)
      enqueue(state, transition.runner, [
        transition.from === 4
          ? homeQueuePoint(Math.max(0, index))
          : BASES[transition.from],
        BASES[transition.to]
      ])
    } else if (transition.type === 'runScored') {
      const index = queue.indexOf(transition.runner)
      if (endsInDugout(state, transition.runner, side)) continue
      const origin =
        state.motions
          .find(m => m.playerId === transition.runner)
          ?.waypoints.at(-1) ?? homeQueuePoint(Math.max(0, index))
      enqueue(state, transition.runner, [origin, BASES[0], side])
      if (index >= 0) {
        queue.splice(index, 1)
        queue.forEach((id, i) => {
          enqueue(state, id, [homeQueuePoint(i + 1), homeQueuePoint(i)])
        })
      }
    } else if (transition.type === 'outRecorded') {
      const index = queue.indexOf(transition.runner)
      const action = state.runnerAction
      const origin =
        action?.playerId === transition.runner && action.runnerPoint != null
          ? action.runnerPoint
          : index >= 0
            ? homeQueuePoint(index)
            : transition.from === 0 && state.pendingPlay?.batterPoint != null
              ? state.pendingPlay.batterPoint
              : BASES[transition.from % 4]
      enqueue(state, transition.runner, [origin, side])
      if (index >= 0) {
        queue.splice(index, 1)
        if (transition.outs < 3)
          queue.forEach((id, i) => {
            enqueue(state, id, [homeQueuePoint(i + 1), homeQueuePoint(i)])
          })
      }
      if (transition.outs >= 3) {
        for (const [i, id] of queue.entries())
          dugout(state, id, homeQueuePoint(i))
        queue = []
      }
    }
  }
}
export function scoringFieldPlayers(
  state: Pick<
    ScoringState,
    | 'presentation'
    | 'session'
    | 'phase'
    | 'pendingPlay'
    | 'motions'
    | 'runnerAction'
  >,
  previous: FieldPlayer[] = []
): FieldPlayer[] {
  if (
    state.presentation?.kind === 'pitch' ||
    state.presentation?.kind === 'throw' ||
    (state.presentation?.kind === 'hit' && state.presentation.stage === 'swing')
  )
    return state.presentation.players.map(player => ({
      ...player,
      receivingBall:
        state.presentation?.kind === 'throw' &&
        state.presentation.receiver === player.playerId,
      position: { ...player.position },
      target: { ...player.target }
    }))
  const session = state.session
  const suppressed = [
    'locateFielder',
    'locateLanding',
    'trajectory',
    'chooseThrower',
    'chooseDefender'
  ].includes(state.phase)
  const players = fieldPlayersFor(session)
  const pending = state.pendingPlay
  const movements = session.pending?.movements ?? []
  const homeQueue = session.homeQueue
  const absent = movements
    .filter(move => move.decision === 'out' || move.to === 4)
    .map(move => move.playerId)
  for (let index = players.length - 1; index >= 0; index--)
    if (
      players[index].team === 'runner' &&
      absent.includes(players[index].playerId!)
    )
      players.splice(index, 1)
  const addRunner = (id: number): FieldPlayer => {
    const existing = players.find(
      player => player.playerId === id && player.team === 'runner'
    )
    if (existing != null) return existing
    const person = session.gameData.players[id]
    const player: FieldPlayer = {
      id: `offense-${id}`,
      playerId: id,
      label: 'Runner',
      name: person.fullName,
      displayName: person.fullName,
      jersey: person.jersey,
      uniformSide:
        person.teamId === session.gameData.teams.home.id ? 'home' : 'away',
      team: 'runner',
      position: { ...BASES[0] },
      target: { ...BASES[0] },
      speed: 0,
      heading: 0,
      stride: 0
    }
    players.push(player)
    return player
  }
  homeQueue.forEach((id, index) => {
    const player = addRunner(id)
    player.position = homeQueuePoint(index)
    player.target = { ...player.position }
    player.labelOrder = 100 - index
    player.runnerBase = 4
  })
  for (const move of movements)
    if (
      move.automaticHome === true &&
      move.resolved !== true &&
      move.homeReleased !== true &&
      !state.motions.some(m => m.playerId === move.playerId && !m.complete)
    ) {
      const player = addRunner(move.playerId)
      player.batting = false
      player.position = {
        ...(state.motions
          .find(m => m.playerId === move.playerId)
          ?.waypoints.at(-1) ?? homeQueuePoint(homeQueue.length))
      }
      player.target = { ...player.position }
      player.labelOrder = 100 - homeQueue.length
      player.runnerBase = 4
    }
  for (const command of state.motions) {
    if (
      command.complete ||
      (state.presentation?.kind === 'hit' &&
        state.presentation.out &&
        command.playerId === state.presentation.batter)
    )
      continue
    const player = addRunner(command.playerId)
    player.batting = false
    player.slowApproach = command.purpose === 'approachFirst'
    const prior = previous.find(
      old =>
        old.id === player.id &&
        old.motion?.id === command.id &&
        old.motion.generation === command.generation
    )
    if (prior != null) {
      player.position = { ...prior.position }
      player.target = { ...prior.target }
      player.speed = prior.speed
      player.heading = prior.heading
      player.stride = prior.stride
      player.motion = prior.motion
    } else {
      player.position = { ...command.waypoints[0] }
      player.target = { ...command.waypoints[1] }
      player.motion = {
        id: command.id,
        generation: command.generation,
        waypoints: command.waypoints.map(point => ({ ...point })),
        index: 1,
        reported: false
      }
    }
  }
  if (state.presentation?.kind === 'hit' && state.presentation.out) {
    const batter = addRunner(state.presentation.batter)
    batter.batting = false
  } else if (
    pending?.batterPoint != null &&
    state.phase === 'chooseDefender' &&
    state.runnerAction?.purpose === 'batterRetirement'
  ) {
    const batter = addRunner(
      session.liveData.plays.currentPlay!.matchup.batter.id
    )
    if (batter.motion == null) {
      batter.position = { ...pending.batterPoint }
      batter.target = { ...pending.batterPoint }
    }
    batter.batting = false
  }
  for (const player of players) {
    if (
      pending != null &&
      player.playerId === pending.fielder &&
      pending.location != null &&
      state.presentation?.kind !== 'hit'
    ) {
      player.position =
        pending.homeRunKind === 'out-of-park'
          ? clampToField(pending.location)
          : { ...pending.location }
      player.target = { ...player.position }
    }
    if (pending != null && player.team === 'defense') {
      for (const action of session.liveData.plays.currentPlay?.source
        .gamestation.runnerActions ?? []) {
        const credit = action.credits.find(
          credit => credit.player.id === player.playerId
        )
        if (credit == null) continue
        const location =
          credit.credit === 'f_assist'
            ? action.throwerLocation
            : (action.defenderLocation ?? action.throwerLocation)
        if (location != null) {
          player.position = { ...location }
          player.target = { ...location }
        }
      }
    }
    if (
      player.playerId === state.runnerAction?.thrower &&
      state.runnerAction?.throwerPoint != null
    ) {
      player.position = { ...state.runnerAction.throwerPoint }
      player.target = { ...player.position }
    }
    if (
      player.playerId === state.runnerAction?.defender &&
      state.runnerAction?.defenderPoint != null
    ) {
      player.position = { ...state.runnerAction.defenderPoint }
      player.target = { ...player.position }
    }
    if (player.team === 'defense') {
      for (const record of session.liveData.plays.currentPlay?.source
        .gamestation.runnerActions ?? [])
        for (const hop of record.defensiveRoute ?? [])
          if (hop.player.id === player.playerId) {
            player.position = { ...hop.location }
            player.target = { ...hop.location }
          }
      for (const hop of state.runnerAction?.defensiveRoute ?? [])
        if (hop.id === player.playerId) {
          player.position = { ...hop.point }
          player.target = { ...hop.point }
        }
      const holder =
        state.runnerAction?.defensiveRoute?.at(-1)?.id ??
        state.runnerAction?.thrower
      player.hasBall =
        state.phase === 'chooseDefender' &&
        state.presentation == null &&
        player.playerId === holder
    }
    player.suppressed =
      state.presentation == null && suppressed && player.team === 'runner'
  }
  return players
}
