import { BASES, clampToField, type FieldPlayer } from '../field/fieldModel'
import { fieldPlayersFor } from './fieldAdapter'
import { homeQueuePoint } from './runnerRules'
import type { ScoringState } from './scoringTypes'
export function scoringFieldPlayers(
  state: Pick<
    ScoringState,
    | 'presentation'
    | 'session'
    | 'phase'
    | 'pendingPlay'
    | 'motions'
    | 'homeQueue'
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
  const absent = (pending?.movements ?? [])
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
  state.homeQueue.forEach((id, index) => {
    const player = addRunner(id)
    player.position = homeQueuePoint(index)
    player.target = { ...player.position }
    player.labelOrder = 100 - index
    player.runnerBase = 4
  })
  for (const move of pending?.movements ?? [])
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
          ?.waypoints.at(-1) ?? homeQueuePoint(state.homeQueue.length))
      }
      player.target = { ...player.position }
      player.labelOrder = 100 - state.homeQueue.length
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
