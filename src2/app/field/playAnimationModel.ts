import {
  type HitSequence,
  PITCH_TIMING,
  type PitchSequence,
  type Point3,
  type ThrowSequence
} from '../scoring/scoringPresentation'
import { pitchingHand } from './athletePose'
import { arcPoint } from './ballArcModel'
import type { GroundPoint } from './fieldModel'
export interface PitchSample {
  ball: Point3
  visible: boolean
  opacity: number
  windup: number
  swing: number
  catch: number
}
const clamp = (n: number): number => Math.max(0, Math.min(1, n))
function lerp(a: Point3, b: Point3, t: number): Point3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t
  }
}
/** Foul flight deliberately bypasses the fair-ball target clamp behind home. */
export function foulPoint(
  plate: Point3,
  side: 'R' | 'L',
  progress: number
): Point3 {
  const t = clamp(progress)
  return {
    x: plate.x + (side === 'R' ? 1 : -1) * 18 * t,
    z: plate.z + 18 * t,
    y: plate.y + Math.SQRT2 * 18 * t - 3 * t * t
  }
}
export function samplePitch(
  sequence: PitchSequence,
  time: number
): PitchSample {
  const foul = sequence.pitch === 'foul'
  let ball: Point3
  if (time < PITCH_TIMING.release)
    ball = pitchingHand(
      sequence.players.find(p => p.playerId === sequence.pitcher)!.position,
      time,
      PITCH_TIMING.release,
      sequence.throwSide
    )
  else if (time < PITCH_TIMING.plate)
    ball = lerp(
      sequence.from,
      sequence.plate,
      clamp(
        (time - PITCH_TIMING.release) /
          (PITCH_TIMING.plate - PITCH_TIMING.release)
      )
    )
  else if (foul)
    ball = foulPoint(
      sequence.plate,
      sequence.batSide,
      (time - PITCH_TIMING.plate) /
        (PITCH_TIMING.foulFinish - PITCH_TIMING.plate)
    )
  else
    ball = lerp(
      sequence.plate,
      sequence.glove,
      clamp(
        (time - PITCH_TIMING.plate) / (PITCH_TIMING.catch - PITCH_TIMING.plate)
      )
    )
  const swinging = sequence.pitch === 'swing' || foul
  return {
    ball,
    visible:
      time >= 0 &&
      (foul ? time < sequence.durationMs : time < PITCH_TIMING.catch),
    opacity: foul ? 1 - clamp((time - (sequence.durationMs - 200)) / 200) : 1,
    windup: Math.sin(clamp(time / (PITCH_TIMING.release * 2)) * Math.PI),
    swing: swinging
      ? Math.sin(clamp((time - (PITCH_TIMING.plate - 200)) / 500) * Math.PI)
      : 0,
    catch: !foul
      ? Math.sin(clamp((time - (PITCH_TIMING.catch - 60)) / 200) * Math.PI)
      : 0
  }
}

export function sampleHit(
  sequence: HitSequence,
  time: number
): {
  ball: Point3
  visible: boolean
  swing: number
  fielder: GroundPoint
  running: boolean
} {
  const flight = clamp(
    (time - sequence.contactMs) / (sequence.durationMs - sequence.contactMs)
  )
  return {
    ball: arcPoint(sequence.arc, flight),
    visible: time >= sequence.contactMs && time < sequence.durationMs,
    swing: Math.sin(clamp((time - 250) / 400) * Math.PI),
    fielder: {
      x:
        sequence.fielderStart.x +
        (sequence.arc.target.x - sequence.fielderStart.x) * flight,
      z:
        sequence.fielderStart.z +
        (sequence.arc.target.z - sequence.fielderStart.z) * flight
    },
    running: flight > 0 && flight < 1
  }
}

export function sampleThrow(
  sequence: ThrowSequence,
  time: number
): { ball: Point3; visible: boolean; progress: number; swing: number } {
  const t = clamp(
    (time - (sequence.unassisted ? 0 : 150)) /
      (sequence.durationMs - (sequence.unassisted ? 0 : 150))
  )
  const ball = lerp(sequence.from, sequence.to, t)
  ball.y += Math.sin(t * Math.PI) * (sequence.unassisted ? 0 : 3)
  return {
    ball,
    visible: !sequence.unassisted && time >= 150 && time < sequence.durationMs,
    progress: t,
    swing: 0
  }
}
