/* eslint-disable react/no-unknown-property -- React Three Fiber scene elements. */
import { useFrame, useThree } from '@react-three/fiber'
import React, { useEffect, useRef, useState } from 'react'
import { type Mesh, MeshBasicMaterial, SphereGeometry } from 'three'

import { scoringAudio } from '../scoring/scoringAudio'
import {
  outBatterPoint,
  PITCH_TIMING,
  presentationRuntime,
  type PresentationSequence,
  stepPresentation,
  THROW_RELEASE_MS
} from '../scoring/scoringPresentation'
import { battingPose, buntingPose, pitchingPose } from './athletePose'
import { BALL_CONTACT } from './ballArcModel'
import { fielderKey, type FieldPlayer } from './fieldModel'
import {
  DEFENDER_SPEED,
  sampleHit,
  samplePitch,
  sampleThrow
} from './playAnimationModel'
export function PlayAnimation({
  sequence,
  players,
  paused,
  onComplete,
  onContact
}: {
  sequence: PresentationSequence
  players: FieldPlayer[]
  paused: boolean
  onContact?: (id: string, generation: number) => void
  onComplete: (
    id: string,
    generation: number,
    stage: PresentationSequence['stage']
  ) => void
}): React.ReactElement {
  const runtime = useRef(presentationRuntime())
  const skipElapsed = useRef(true)
  const ball = useRef<Mesh>(null)
  const material = ballLook()
  const camera = useThree(state => state.camera)
  const invalidate = useThree(state => state.invalidate)
  useEffect(() => {
    invalidate()
    return () => {
      for (const player of players) delete player.pose
    }
  }, [invalidate, players])
  useEffect(
    () => () => {
      scoringAudio.stop()
    },
    []
  )
  useEffect(() => {
    skipElapsed.current = true
    if (paused) scoringAudio.stop()
    invalidate()
  }, [paused, invalidate])
  // Update the shared pose before persistent Player/AthleteRig mesh subscribers.
  useFrame((_, dt) => {
    const frame = stepPresentation(
      runtime.current,
      sequence,
      skipElapsed.current ? 0 : dt * 1000,
      paused
    )
    skipElapsed.current = false
    const sample =
      sequence.kind === 'pitch'
        ? samplePitch(sequence, runtime.current.elapsedMs, camera.position)
        : sequence.kind === 'hit'
          ? sampleHit(sequence, runtime.current.elapsedMs)
          : sampleThrow(sequence, runtime.current.elapsedMs)
    if (ball.current != null) {
      ball.current.position.set(sample.ball.x, sample.ball.y, sample.ball.z)
      ball.current.visible = sample.visible
    }
    material.opacity = 'opacity' in sample ? sample.opacity : 1
    for (const player of players) {
      player.pose = {
        windup:
          sequence.kind !== 'throw' &&
          player.playerId === sequence.pitcher &&
          'windup' in sample
            ? sample.windup
            : 0,
        swing:
          sequence.kind !== 'throw' && player.playerId === sequence.batter
            ? sample.swing
            : 0,
        catch:
          sequence.kind === 'pitch' &&
          player.playerId === sequence.catcher &&
          'catch' in sample
            ? sample.catch
            : 0,
        throwSide: sequence.kind === 'throw' ? 'R' : (sequence.throwSide ?? 'R')
      }
      // A pitch has no windup: the pitcher stands while the ball, out of
      // his hand at once, goes to the plate.
      if (
        sequence.kind !== 'throw' &&
        player.playerId === sequence.batter &&
        (sequence.kind === 'hit'
          ? runtime.current.elapsedMs <= sequence.contactMs + 300
          : sequence.pitch === 'swing' || sequence.pitch === 'foul')
      ) {
        const origin = sequence.players.find(
          p => p.playerId === sequence.batter
        )!.position
        const pose =
          sequence.kind === 'hit' && sequence.contactKind === 'bunt'
            ? buntingPose
            : battingPose
        player.pose.athlete = pose(
          runtime.current.elapsedMs,
          sequence.kind === 'pitch' ? PITCH_TIMING.plate : sequence.contactMs,
          sequence.batSide,
          origin,
          { x: 0, y: BALL_CONTACT, z: 0 },
          sequence.kind === 'pitch' && sequence.pitch === 'swing'
        )
      }
      if (
        sequence.kind === 'hit' &&
        sequence.out &&
        sequence.stage === 'flight' &&
        player.playerId === sequence.batter
      ) {
        const point = outBatterPoint(sequence, runtime.current.elapsedMs)
        const start = sequence.players.find(
          p => p.playerId === sequence.batter
        )!.position
        player.position = point
        player.target = { ...point }
        player.batting = false
        player.heading = Math.atan2(point.x - start.x, point.z - start.z)
        player.stride = runtime.current.elapsedMs * 0.012
        player.pose.run = 1
      }
      if (sequence.kind === 'throw' && 'progress' in sample) {
        if (fielderKey(player) === sequence.thrower) {
          if (sequence.unassisted) {
            player.position = { x: sample.ball.x, z: sample.ball.z }
            player.target = { ...player.position }
            player.heading = Math.atan2(
              sequence.to.x - sequence.from.x,
              sequence.to.z - sequence.from.z
            )
            player.stride = runtime.current.elapsedMs * 0.012 * DEFENDER_SPEED
            player.pose.run = sample.defenderProgress < 1 ? 1 : 0
          } else {
            player.pose.athlete = pitchingPose(
              runtime.current.elapsedMs,
              THROW_RELEASE_MS,
              sequence.throwSide
            )
            player.pose.athleteHeading = sequence.heading
          }
        }
        if (sequence.stage === 'tag' && player.playerId === sequence.runner) {
          player.position = {
            x:
              sequence.runnerFrom.x +
              (sequence.to.x - sequence.runnerFrom.x) * sample.runnerProgress,
            z:
              sequence.runnerFrom.z +
              (sequence.to.z - sequence.runnerFrom.z) * sample.runnerProgress
          }
          player.target = { ...player.position }
          player.heading = Math.atan2(
            sequence.to.x - sequence.runnerFrom.x,
            sequence.to.z - sequence.runnerFrom.z
          )
          player.stride = runtime.current.elapsedMs * 0.012
          player.pose.run = sample.runnerProgress < 1 ? 1 : 0
        }
        if (fielderKey(player) === sequence.receiver)
          player.pose.catch = sample.progress > 0.8 ? 1 : 0
      }
      if (
        sequence.kind === 'hit' &&
        'fielder' in sample &&
        sequence.fielder != null &&
        fielderKey(player) === sequence.fielder
      ) {
        player.position = { ...sample.fielder }
        player.target = { ...sample.fielder }
        player.heading = Math.atan2(
          sequence.arc.target.x - sequence.fielderStart.x,
          sequence.arc.target.z - sequence.fielderStart.z
        )
        player.stride = runtime.current.elapsedMs * 0.012 * DEFENDER_SPEED
        player.pose.run = sample.running ? 1 : 0
        player.pose.catch =
          sequence.outOfPark !== true &&
          runtime.current.elapsedMs > sequence.durationMs - 200
            ? 1
            : 0
      }
    }
    if (frame.contact === true) onContact?.(sequence.id, sequence.generation)
    for (const cue of frame.cues) scoringAudio.cue(cue)
    if (frame.done) onComplete(sequence.id, sequence.generation, sequence.stage)
    if (!paused && !runtime.current.complete) invalidate()
  }, -1)
  return (
    <mesh
      ref={ball}
      name="animated-baseball"
      visible={false}
      geometry={ballShape()}
      material={material}
      // Shared by every presentation (`ballLook`), so never disposed.
      dispose={null}
    />
  )
}

/**
 * Draws the pitched ball, see-through, on the field's first two frames on the
 * pitch's path, then leaves. Its shader is compiled and its pixels first drawn
 * with the field (a software GPU builds them on the first draw), so the first
 * pitch after the screen opens starts as fast as every later one. `onDrawn`
 * hears once the frame without it has been drawn.
 */
export function BallWarmup({
  onDrawn
}: {
  onDrawn?: () => void
}): React.ReactElement | null {
  const frames = useRef(0)
  const [drawn, setDrawn] = useState(false)
  const invalidate = useThree(state => state.invalidate)
  const heard = useRef(onDrawn)
  heard.current = onDrawn
  useFrame(() => {
    frames.current += 1
    if (frames.current < 2) invalidate()
    else if (!drawn) setDrawn(true)
  })
  useEffect(() => {
    if (!drawn) return
    invalidate()
    // The field's frame loop asked first, so it draws before this runs.
    const frame = requestAnimationFrame(() => {
      heard.current?.()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [drawn, invalidate])
  if (drawn) return null
  return (
    <mesh
      name="ball-warmup"
      position={[0, 3, -9]}
      frustumCulled={false}
      geometry={ballShape()}
      material={ballParts().warmup}
      // Shared parts, never disposed (see `ballParts`).
      dispose={null}
    />
  )
}

interface BallParts {
  shape: SphereGeometry
  look: MeshBasicMaterial
  /** The look with nothing showing, which shares its shader (`BallWarmup`). */
  warmup: MeshBasicMaterial
}
let ball: BallParts | null = null
function ballParts(): BallParts {
  if (ball == null) {
    const look = new MeshBasicMaterial({
      color: '#fff7de',
      transparent: true,
      toneMapped: false
    })
    const warmup = look.clone()
    warmup.opacity = 0
    ball = { shape: new SphereGeometry(0.45, 12, 8), look, warmup }
  }
  return ball
}
function ballShape(): SphereGeometry {
  return ballParts().shape
}
function ballLook(): MeshBasicMaterial {
  return ballParts().look
}
