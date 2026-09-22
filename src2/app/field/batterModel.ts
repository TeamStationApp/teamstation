import { BASES, createPlayers, type FieldPlayer } from './fieldModel'

/** Right-handed box: third-base side, left shoulder pointing toward the pitcher. */
export function createStartingPlayers(): FieldPlayer[] {
  return [
    ...createPlayers().filter(player => player.team === 'defense'),
    {
      id: 'B',
      label: 'B',
      name: 'Batter',
      displayName: 'Alex R.',
      number: 14,
      team: 'runner',
      position: { x: -4, z: 0 },
      target: { x: -4, z: 0 },
      heading: Math.PI / 2,
      speed: 0,
      stride: 0,
      runnerBase: 0,
      batting: true
    }
  ]
}
export function clonePlayers(players: FieldPlayer[]): FieldPlayer[] {
  return players.map(player => ({
    ...player,
    position: { ...player.position },
    target: { ...player.target },
    droppedBat: player.droppedBat == null ? undefined : { ...player.droppedBat }
  }))
}
export function startBatterRun(players: FieldPlayer[]): FieldPlayer[] {
  return players.map(player =>
    player.batting !== true
      ? player
      : {
          ...player,
          batting: false,
          dragging: false,
          target: { ...BASES[1] },
          droppedBat: {
            x: player.position.x + 1.84,
            z: player.position.z + 1.656,
            heading: player.heading
          }
        }
  )
}
