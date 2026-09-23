import {
  PITCH_TIMING,
  type Point3,
  type PresentationSequence
} from '../scoring/scoringPresentation'
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
  sequence: PresentationSequence,
  time: number
): PitchSample {
  const foul = sequence.pitch === 'foul'
  let ball: Point3
  if (time < PITCH_TIMING.release) ball = sequence.from
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
      time >= PITCH_TIMING.release &&
      (foul ? time < sequence.durationMs : time < PITCH_TIMING.catch),
    opacity: foul ? 1 - clamp((time - 1200) / 200) : 1,
    windup: Math.sin(clamp(time / 600) * Math.PI),
    swing: swinging ? Math.sin(clamp((time - 500) / 420) * Math.PI) : 0,
    catch: !foul ? Math.sin(clamp((time - 800) / 200) * Math.PI) : 0
  }
}
