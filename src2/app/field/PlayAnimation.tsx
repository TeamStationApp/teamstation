/* eslint-disable react/no-unknown-property -- React Three Fiber scene elements. */
import { useFrame, useThree } from '@react-three/fiber'
import React, { useEffect, useRef } from 'react'
import type { Mesh, MeshBasicMaterial } from 'three'

import { scoringAudio } from '../scoring/scoringAudio'
import {
  outBatterPoint,
  PITCH_TIMING,
  presentationRuntime,
  type PresentationSequence,
  stepPresentation
} from '../scoring/scoringPresentation'
import { battingPose, pitchingPose } from './athletePose'
import { BALL_CONTACT } from './ballArcModel'
import type { FieldPlayer } from './fieldModel'
import { sampleHit, samplePitch, sampleThrow } from './playAnimationModel'
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
  const material = useRef<MeshBasicMaterial>(null)
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
        ? samplePitch(sequence, runtime.current.elapsedMs)
        : sequence.kind === 'hit'
          ? sampleHit(sequence, runtime.current.elapsedMs)
          : sampleThrow(sequence, runtime.current.elapsedMs)
    if (ball.current != null) {
      ball.current.position.set(sample.ball.x, sample.ball.y, sample.ball.z)
      ball.current.visible = sample.visible
    }
    if (material.current != null)
      material.current.opacity = 'opacity' in sample ? sample.opacity : 1
    for (const player of players) {
      player.pose = {
        windup:
          sequence.kind === 'pitch' &&
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
        throwSide: sequence.kind === 'pitch' ? sequence.throwSide : 'R'
      }
      if (sequence.kind === 'pitch' && player.playerId === sequence.pitcher)
        player.pose.athlete = pitchingPose(
          runtime.current.elapsedMs,
          PITCH_TIMING.release,
          sequence.throwSide
        )
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
        player.pose.athlete = battingPose(
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
        if (player.playerId === sequence.thrower) {
          if (sequence.unassisted) {
            player.position = { x: sample.ball.x, z: sample.ball.z }
            player.target = { ...player.position }
            player.heading = Math.atan2(
              sequence.to.x - sequence.from.x,
              sequence.to.z - sequence.from.z
            )
            player.stride = runtime.current.elapsedMs * 0.012
            player.pose.run = sample.progress < 1 ? 1 : 0
          } else {
            player.pose.athlete = pitchingPose(
              runtime.current.elapsedMs,
              150,
              sequence.throwSide
            )
            player.pose.athleteHeading = sequence.heading
          }
        }
        if (sequence.stage === 'tag' && player.playerId === sequence.runner) {
          player.position = {
            x:
              sequence.runnerFrom.x +
              (sequence.to.x - sequence.runnerFrom.x) * sample.progress,
            z:
              sequence.runnerFrom.z +
              (sequence.to.z - sequence.runnerFrom.z) * sample.progress
          }
          player.target = { ...player.position }
          player.heading = Math.atan2(
            sequence.to.x - sequence.runnerFrom.x,
            sequence.to.z - sequence.runnerFrom.z
          )
          player.stride = runtime.current.elapsedMs * 0.012
          player.pose.run = sample.progress < 1 ? 1 : 0
        }
        if (player.playerId === sequence.receiver)
          player.pose.catch = sample.progress > 0.8 ? 1 : 0
      }
      if (
        sequence.kind === 'hit' &&
        'fielder' in sample &&
        sequence.fielder != null &&
        player.playerId === sequence.fielder
      ) {
        player.position = { ...sample.fielder }
        player.target = { ...sample.fielder }
        player.heading = Math.atan2(
          sequence.arc.target.x - sequence.fielderStart.x,
          sequence.arc.target.z - sequence.fielderStart.z
        )
        player.stride = runtime.current.elapsedMs * 0.012
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
  })
  return (
    <mesh ref={ball} name="animated-baseball" visible={false}>
      <sphereGeometry args={[0.45, 12, 8]} />
      <meshBasicMaterial
        ref={material}
        color="#fff7de"
        transparent
        toneMapped={false}
      />
    </mesh>
  )
}
