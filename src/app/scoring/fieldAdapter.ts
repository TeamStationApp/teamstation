import { createStartingPlayers } from '../field/batterModel'
import { BASES, createPlayers, type FieldPlayer } from '../field/fieldModel'
import { shortPlayerNames } from './currentSetup'
import { baseIds } from './scoringSelectors'
import { POSITIONS, type ScoringSessionState } from './scoringTypes'

/** Every nested vector belongs to the renderer, never to the reducer/history. */
export function fieldPlayersFor(session: ScoringSessionState): FieldPlayer[] {
  const templates = createPlayers()
  const line = session.liveData.linescore
  const labels = shortPlayerNames(Object.values(session.gameData.players))
  const label = (id: number): string => labels.get(id) ?? ''
  const players: FieldPlayer[] = []
  for (const position of POSITIONS) {
    const ref = line.defense[position]
    if (ref == null) continue
    const template = templates.find(player => player.id === position)
    if (template == null) continue
    const player = session.gameData.players[ref.id]
    players.push({
      ...template,
      id: `defense-${ref.id}`,
      playerId: ref.id,
      name: label(ref.id),
      displayName: label(ref.id),
      uniformSide:
        player.teamId === session.gameData.teams.home.id ? 'home' : 'away',
      jersey: player.jersey
    })
  }
  const occupied = baseIds(session)
  occupied.forEach((id, index) => {
    if (id == null) return
    const player = session.gameData.players[id]
    players.push({
      id: `offense-${id}`,
      playerId: id,
      label: `R${index + 1}`,
      name: label(id),
      displayName: label(id),
      uniformSide:
        player.teamId === session.gameData.teams.home.id ? 'home' : 'away',
      jersey: player.jersey,
      team: 'runner',
      position: { ...BASES[index + 1] },
      target: { ...BASES[index + 1] },
      heading: 0,
      speed: 0,
      stride: 0,
      runnerBase: index + 1
    })
  })
  const batter = line.offense.batter
  if (batter != null && !occupied.includes(batter.id)) {
    const template = createStartingPlayers().find(
      player => player.batting === true
    )
    if (template == null) throw new Error('Missing batter template')
    const player = session.gameData.players[batter.id]
    const side = session.liveData.plays.currentPlay?.matchup.batSide.code ?? 'R'
    const position = { x: side === 'R' ? -4 : 4, z: 0 }
    players.push({
      ...template,
      id: `offense-${batter.id}`,
      playerId: batter.id,
      name: label(batter.id),
      displayName: label(batter.id),
      uniformSide:
        player.teamId === session.gameData.teams.home.id ? 'home' : 'away',
      jersey: player.jersey,
      batSide: side,
      position,
      target: { ...position },
      heading: side === 'R' ? Math.PI / 2 : -Math.PI / 2
    })
  }
  return players
}
