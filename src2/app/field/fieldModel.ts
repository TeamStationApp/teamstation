import type { AthletePose } from './athletePose'

/** Ground coordinates are metres: home is (0, 0), centre field is negative z. */
export interface GroundPoint {
  x: number
  z: number
}
export interface FieldPlayer {
  hasBall?: boolean
  pose?: {
    athleteHeading?: number
    athlete?: AthletePose
    windup: number
    swing: number
    catch: number
    throwSide: 'R' | 'L'
    run?: number
  }
  suppressed?: boolean
  keyboardOrigin?: GroundPoint
  labelOrder?: number
  motion?: {
    id: string
    generation: number
    waypoints: GroundPoint[]
    index: number
    reported: boolean
  }
  id: string
  label: string
  name: string
  displayName: string
  jersey: string
  playerId?: number
  batSide?: 'R' | 'L'
  team: 'defense' | 'runner'
  position: GroundPoint
  target: GroundPoint
  heading: number
  speed: number
  stride: number
  dragging?: boolean
  batting?: boolean
  droppedBat?: { x: number; z: number; heading: number }
  runnerBase?: number
}
export type CameraView = 'home' | 'overhead' | 'infield' | 'scoreboard'
export const BASE = 27.432 / Math.sqrt(2)
export const BASES: GroundPoint[] = [
  { x: 0, z: 0 },
  { x: BASE, z: -BASE },
  { x: 0, z: -2 * BASE },
  { x: -BASE, z: -BASE }
]
export function createPlayers(): FieldPlayer[] {
  const positions: Array<[string, string, number, number]> = [
    ['P', 'Pitcher', 0, -18.44],
    ['C', 'Catcher', 0, 4],
    ['1B', 'First baseman', 24, -23],
    ['2B', 'Second baseman', 15, -41],
    ['SS', 'Shortstop', -15, -41],
    ['3B', 'Third baseman', -24, -23],
    ['LF', 'Left fielder', -44, -69],
    ['CF', 'Center fielder', 0, -88],
    ['RF', 'Right fielder', 44, -69],
    ['R1', 'Runner on first', BASE - 2, -BASE - 2],
    ['R2', 'Runner on second', -2, -2 * BASE + 2],
    ['R3', 'Runner on third', -BASE + 2, -BASE + 2]
  ]
  return positions.map(([id, name, x, z], index) => ({
    id,
    label: id,
    name,
    displayName: [
      'James W.',
      'Noah C.',
      'Liam B.',
      'Ethan K.',
      'Mason L.',
      'Lucas M.',
      'Owen R.',
      'Logan D.',
      'Jack S.',
      'Alex R.',
      'Leo T.',
      'Max P.'
    ][index],
    jersey: String([18, 2, 24, 7, 12, 5, 21, 9, 33, 14, 6, 27][index]),
    team: index < 9 ? 'defense' : 'runner',
    position: { x, z },
    target: { x, z },
    heading: index === 1 ? Math.PI : 0,
    speed: 0,
    runnerBase: index >= 9 ? index - 8 : undefined,
    stride: 0
  }))
}
/** Keep free positioning on the playable surface, including a little foul territory. */
export function clampToField(point: GroundPoint): GroundPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z))
    return { x: 0, z: 0 }
  const z = Math.max(-108, Math.min(7, point.z))
  const limit = Math.min(80, Math.max(10, -z + 9))
  const x = Math.max(-limit, Math.min(limit, point.x))
  const radius = Math.hypot(x, z)
  return radius > 110
    ? { x: (x * 110) / radius, z: (z * 110) / radius }
    : { x, z }
}
export function setDestination(player: FieldPlayer, point: GroundPoint): void {
  player.target = clampToField(point)
}
/** Frame-rate independent locomotion; cap elapsed time after a backgrounded tab. */
export function advancePlayer(player: FieldPlayer, elapsed: number): void {
  if (player.dragging === true) {
    player.speed = 0
    return
  }
  const dt = Math.max(0, Math.min(elapsed, 0.05))
  const dx = player.target.x - player.position.x
  const dz = player.target.z - player.position.z
  const distance = Math.hypot(dx, dz)
  if (distance < 0.035) {
    player.position = { ...player.target }
    player.speed = 0
    if (player.team === 'runner') {
      const base = BASES.findIndex(
        b => Math.hypot(b.x - player.position.x, b.z - player.position.z) < 0.1
      )
      if (base >= 0) player.runnerBase = base
    }
    return
  }
  const desired = Math.atan2(dx, dz)
  const turn = Math.atan2(
    Math.sin(desired - player.heading),
    Math.cos(desired - player.heading)
  )
  player.heading += turn * (1 - Math.exp(-16 * dt))
  const speed = 1.4 * Math.min(17, 4 + distance * 1.1)
  const step = Math.min(distance, speed * dt)
  player.position.x += (dx / distance) * step
  player.position.z += (dz / distance) * step
  player.speed = dt > 0 ? step / dt : 0
  player.stride += step * 1.85
}
export function nextBase(player: FieldPlayer): GroundPoint {
  if (player.runnerBase != null)
    return { ...BASES[(player.runnerBase + 1) % BASES.length] }
  let nearest = 0
  let distance = Infinity
  BASES.forEach((base, index) => {
    const d = Math.hypot(base.x - player.target.x, base.z - player.target.z)
    if (d < distance) {
      distance = d
      nearest = index
    }
  })
  return { ...BASES[(nearest + 1) % BASES.length] }
}
