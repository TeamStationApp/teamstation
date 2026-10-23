import {
  foulFlightMs,
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
export const DEFENDER_SPEED = 3
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
  progress: number,
  camera?: Point3
): Point3 {
  const t = clamp(progress)
  if (camera != null) {
    // Reach 40% of the contact depth before fading: fixed radius projects 2.5x larger.
    const travel = Math.sin((t * Math.PI) / 2)
    const approach = 0.6 * travel
    const lateral =
      Math.hypot(camera.x - plate.x, camera.y - plate.y, camera.z - plate.z) *
      0.035 *
      travel
    return {
      x:
        plate.x +
        (camera.x - plate.x) * approach +
        (side === 'R' ? lateral : -lateral),
      y: plate.y + (camera.y - plate.y) * approach,
      z: plate.z + (camera.z - plate.z) * approach
    }
  }
  return {
    x: plate.x + (side === 'R' ? 1 : -1) * 18 * t,
    z: plate.z + 18 * t,
    y: plate.y + Math.SQRT2 * 18 * t - 3 * t * t
  }
}
/**
 * A foul the scorer placed, from the bat to where it came down: up in an
 * arc as high as a third of its distance, then resting there.
 */
function placedFoulPoint(
  plate: Point3,
  foul: GroundPoint,
  time: number
): Point3 {
  const t = clamp((time - PITCH_TIMING.plate) / foulFlightMs(foul))
  const apex = Math.hypot(foul.x - plate.x, foul.z - plate.z) / 3
  return {
    x: plate.x + (foul.x - plate.x) * t,
    y: plate.y * (1 - t) + 4 * apex * t * (1 - t),
    z: plate.z + (foul.z - plate.z) * t
  }
}

export function samplePitch(
  sequence: PitchSequence,
  time: number,
  camera?: Point3
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
  else if (foul && sequence.foul != null)
    ball = placedFoulPoint(sequence.plate, sequence.foul, time)
  else if (foul)
    ball = foulPoint(
      sequence.plate,
      sequence.batSide,
      (time - PITCH_TIMING.plate) /
        (PITCH_TIMING.foulFinish - PITCH_TIMING.plate),
      camera
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

/**
 * A ball off the wall after its flight: it drops from where it met the wall,
 * touches the ground once halfway, and comes to rest on the carom.
 */
function caromPoint(sequence: HitSequence, time: number): Point3 | undefined {
  const carom = sequence.carom
  if (carom == null || time <= sequence.flightEndMs) return undefined
  const wall = sequence.arc.target
  const height = sequence.arc.landingHeight ?? 0
  const t = clamp(
    (time - sequence.flightEndMs) / (sequence.durationMs - sequence.flightEndMs)
  )
  const y =
    t < 0.5
      ? height * (1 - (t * 2) ** 2)
      : Math.sin((t - 0.5) * 2 * Math.PI) * 0.8
  return {
    x: wall.x + (carom.x - wall.x) * t,
    y: Math.max(0, y),
    z: wall.z + (carom.z - wall.z) * t
  }
}

/**
 * Where the pitch a ball in play was hit off is before contact: in the
 * pitcher's hand to the release, then on its way to the plate.
 */
function pitchedPoint(
  sequence: HitSequence & { from: Point3; plate: Point3 },
  time: number
): Point3 {
  const mound = sequence.players.find(
    player => player.playerId === sequence.pitcher
  )?.position
  if (time < PITCH_TIMING.release && mound != null)
    return pitchingHand(
      mound,
      time,
      PITCH_TIMING.release,
      sequence.throwSide ?? 'R'
    )
  return lerp(
    sequence.from,
    sequence.plate,
    clamp(
      (time - PITCH_TIMING.release) /
        (sequence.contactMs - PITCH_TIMING.release)
    )
  )
}

export function sampleHit(
  sequence: HitSequence,
  time: number
): {
  ball: Point3
  visible: boolean
  swing: number
  windup: number
  fielder: GroundPoint
  running: boolean
} {
  const pitched =
    sequence.from != null && sequence.plate != null
      ? { ...sequence, from: sequence.from, plate: sequence.plate }
      : undefined
  const flight = clamp(
    (time - sequence.contactMs) / (sequence.flightEndMs - sequence.contactMs)
  )
  const defender = clamp(
    (time - sequence.fielderStartMs) /
      (sequence.fielderEndMs - sequence.fielderStartMs)
  )
  return {
    ball:
      pitched != null && time < sequence.contactMs
        ? pitchedPoint(pitched, time)
        : (caromPoint(sequence, time) ?? arcPoint(sequence.arc, flight)),
    visible:
      time >= (pitched == null ? sequence.contactMs : 0) &&
      time < sequence.durationMs,
    // The swing meets the ball as it reaches the plate.
    swing: Math.sin(clamp((time - (sequence.contactMs - 200)) / 400) * Math.PI),
    windup:
      pitched == null
        ? 0
        : Math.sin(clamp(time / (PITCH_TIMING.release * 2)) * Math.PI),
    fielder: {
      x:
        sequence.fielderStart.x +
        ((sequence.fielderTarget ?? sequence.arc.target).x -
          sequence.fielderStart.x) *
          defender,
      z:
        sequence.fielderStart.z +
        ((sequence.fielderTarget ?? sequence.arc.target).z -
          sequence.fielderStart.z) *
          defender
    },
    running: defender > 0 && defender < 1
  }
}

export function sampleThrow(
  sequence: ThrowSequence,
  time: number
): {
  ball: Point3
  visible: boolean
  progress: number
  defenderProgress: number
  /**
   * How far a tagged runner has run: over the whole picture, so he does not
   * wait out the thrower's windup and arrives with the ball.
   */
  runnerProgress: number
  swing: number
} {
  const t = clamp(
    (time - (sequence.unassisted ? 0 : 150)) /
      (sequence.durationMs - (sequence.unassisted ? 0 : 150))
  )
  const defender = sequence.unassisted ? clamp(t * DEFENDER_SPEED) : t
  const ball =
    !sequence.unassisted && time < 150
      ? pitchingHand(
          sequence.holderOrigin,
          time,
          150,
          sequence.throwSide,
          sequence.heading
        )
      : lerp(sequence.from, sequence.to, defender)
  ball.y += Math.sin(t * Math.PI) * (sequence.unassisted ? 0 : 3)
  return {
    ball,
    visible: !sequence.unassisted && time < sequence.durationMs,
    progress: t,
    defenderProgress: defender,
    runnerProgress: clamp(time / sequence.durationMs),
    swing: 0
  }
}
