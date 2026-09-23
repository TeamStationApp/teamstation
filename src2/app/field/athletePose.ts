import type { Point3 } from '../scoring/scoringPresentation'
import type { GroundPoint } from './fieldModel'
import { PLAYER_SCALE } from './playerPresentation'
import { TERRAIN } from './terrain'

export type Joint = [number, number, number]
export interface AthletePose {
  pelvis: number
  torso: number
  lean: number
  shoulders: [Joint, Joint]
  elbows: [Joint, Joint]
  hands: [Joint, Joint]
  knees: [Joint, Joint]
  feet: [Joint, Joint]
  bat?: { knob: Joint; direction: Joint }
}
const clamp = (n: number): number => Math.max(0, Math.min(1, n))
const ease = (n: number): number => {
  const t = clamp(n)
  return t * t * (3 - 2 * t)
}
const mix = (a: Joint, b: Joint, t: number): Joint =>
  a.map((v, i) => v + (b[i] - v) * t) as Joint
function yaw(point: Joint, angle: number): Joint {
  return [
    point[0] * Math.cos(angle) + point[2] * Math.sin(angle),
    point[1],
    point[2] * Math.cos(angle) - point[0] * Math.sin(angle)
  ]
}
function shoulders(angle: number, lean: number): [Joint, Joint] {
  return [-1, 1].map(side => yaw([side * 0.56, 1.93, lean * 0.5], angle)) as [
    Joint,
    Joint
  ]
}
function elbows(
  shoulder: [Joint, Joint],
  hands: [Joint, Joint],
  bend = 0.32
): [Joint, Joint] {
  return shoulder.map((p, i) => {
    const e = mix(p, hands[i], 0.5)
    e[1] -= bend
    e[2] += 0.2
    return e
  }) as [Joint, Joint]
}
/** Ordered loading, hip opening, trunk acceleration, arm release, recovery. */
export function pitchingPose(
  time: number,
  release: number,
  side: 'R' | 'L'
): AthletePose {
  const s = side === 'R' ? 1 : -1
  const t = time / release
  const load = ease(t / 0.42)
  const open = ease((t - 0.45) / 0.55)
  const unwind = ease((t - 0.64) / 0.36)
  const follow = ease((t - 1) / 0.5)
  const recover = ease((t - 1.5) / 0.7)
  const pelvis = s * (-0.62 * load + 1.22 * open) * (1 - recover)
  const torso =
    s * (-0.85 * load + 1.8 * unwind + 0.25 * follow) * (1 - recover)
  const lean = 0.55 * follow * (1 - recover)
  const shoulder = shoulders(torso, lean)
  const rest: Joint = [s * 0.56, 1.15, 0.2]
  const cock: Joint = [s * 0.9, 2.55, -0.4]
  const releaseHand: Joint = [s * 0.35, 2.15, 0.7]
  const finish: Joint = [-s * 0.5, 1.1, 0.75]
  let hand =
    t < 0.65
      ? mix(rest, cock, ease(t / 0.65))
      : t < 1
        ? mix(cock, releaseHand, ease((t - 0.65) / 0.35))
        : mix(releaseHand, finish, follow)
  hand = mix(hand, rest, recover)
  const glove: Joint = [-s * 0.55, 1.5, 0.45 * (1 - follow)]
  const hands: [Joint, Joint] = side === 'R' ? [glove, hand] : [hand, glove]
  const lift = Math.sin(clamp(t / 0.65) * Math.PI) * 0.65
  const stride = ease((t - 0.4) / 0.5) * 0.65 * (1 - recover)
  const feet: [Joint, Joint] = [
    [-0.28, 0.12, 0],
    [0.28, 0.12, 0]
  ]
  const lead = side === 'R' ? 0 : 1
  feet[lead] = [lead === 0 ? -0.28 : 0.28, 0.12 + lift, stride]
  const knees = feet.map((foot, i) =>
    mix([i === 0 ? -0.23 : 0.23, 1.02, 0], foot, 0.5)
  ) as [Joint, Joint]
  knees[lead][2] += lift * 0.5
  return {
    pelvis,
    torso,
    lean,
    shoulders: shoulder,
    elbows: elbows(shoulder, hands, -0.12 * (1 - follow)),
    hands,
    knees,
    feet
  }
}
export function pitchingHand(
  origin: GroundPoint,
  time: number,
  release: number,
  side: 'R' | 'L',
  heading = 0
): Point3 {
  const hand = yaw(
    pitchingPose(time, release, side).hands[side === 'R' ? 1 : 0],
    heading
  )
  return {
    x: origin.x + hand[0] * PLAYER_SCALE,
    y: TERRAIN.players + hand[1] * PLAYER_SCALE,
    z: origin.z + hand[2] * PLAYER_SCALE
  }
}
/** The barrel's contact station is shared by rendered bat and ball flight. */
export const BAT_CONTACT_DISTANCE = 1.35
export function battingPose(
  time: number,
  contactMs: number,
  side: 'R' | 'L',
  origin: GroundPoint,
  contact: Point3,
  miss = false
): AthletePose {
  const s = side === 'R' ? 1 : -1
  const relative = time - contactMs
  const load = ease((relative + 450) / 220)
  const hips = ease((relative + 180) / 300)
  const trunk = ease((relative + 125) / 300)
  const before = ease((relative + 110) / 110)
  const after = ease(relative / 300)
  const sweep = relative <= 0 ? -1.65 * (1 - before) : 2.1 * after
  const recovery = ease((relative - 350) / 300)
  const direction: Joint = [
    s * Math.cos(sweep),
    0.18 * Math.abs(Math.sin(sweep)),
    -Math.sin(sweep)
  ]
  const upright: Joint = [s * 0.25, 0.94, 0.22]
  const uprightWeight = relative < 0 ? 1 - before : recovery
  for (let i = 0; i < 3; i++)
    direction[i] =
      direction[i] * (1 - uprightWeight) + upright[i] * uprightWeight
  const magnitude = Math.hypot(...direction)
  for (let i = 0; i < 3; i++) direction[i] /= magnitude
  const contactKnob: Joint = [
    (contact.x - origin.x) / PLAYER_SCALE - s * BAT_CONTACT_DISTANCE,
    (contact.y - TERRAIN.players) / PLAYER_SCALE + (miss ? 0.3 : 0),
    (contact.z - origin.z) / PLAYER_SCALE
  ]
  const ready: Joint = [-s * 0.3, 2.02, 0.4]
  const finish: Joint = [s * 0.5, 2.15, -0.35]
  let knob =
    relative <= 0
      ? mix(ready, contactKnob, before)
      : mix(contactKnob, finish, after)
  knob = mix(knob, ready, recovery)
  const hands: [Joint, Joint] = [
    knob,
    knob.map((v, i) => v + direction[i] * 0.15) as Joint
  ]
  const torso =
    s * (Math.PI / 2 + (-0.22 * load + 1.25 * trunk) * (1 - recovery))
  const pelvis =
    s * (Math.PI / 2 + (-0.12 * load + 1.25 * hips) * (1 - recovery))
  const shoulder = shoulders(torso, 0.12)
  // The lead shoe stays planted through contact; the rear heel pivots up.
  const feet: [Joint, Joint] = [
    [-0.05, 0.12, -0.43],
    [0.05, 0.12 + 0.1 * after, 0.43]
  ]
  const knees: [Joint, Joint] = [
    [-0.12, 0.53, -0.35],
    [0.12, 0.53, 0.35]
  ]
  return {
    pelvis,
    torso,
    lean: 0.12,
    shoulders: shoulder,
    elbows: elbows(shoulder, hands),
    hands,
    knees,
    feet,
    bat: { knob, direction }
  }
}
