/* eslint-disable react/no-unknown-property -- React Three Fiber scene elements. */
import { useFrame, useThree } from '@react-three/fiber'
import React, { useEffect, useRef } from 'react'
import type { Mesh, MeshBasicMaterial } from 'three'

import { scoringAudio } from '../scoring/scoringAudio'
import {
  presentationRuntime,
  type PresentationSequence,
  stepPresentation
} from '../scoring/scoringPresentation'
import type { FieldPlayer } from './fieldModel'
import { samplePitch } from './playAnimationModel'
export function PlayAnimation({
  sequence,
  players,
  paused,
  onComplete
}: {
  sequence: PresentationSequence
  players: FieldPlayer[]
  paused: boolean
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
      scoringAudio.stop()
      for (const player of players) delete player.pose
    }
  }, [invalidate, players])
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
    const sample = samplePitch(sequence, runtime.current.elapsedMs)
    if (ball.current != null) {
      ball.current.position.set(sample.ball.x, sample.ball.y, sample.ball.z)
      ball.current.visible = sample.visible
    }
    if (material.current != null) material.current.opacity = sample.opacity
    for (const player of players) {
      player.pose = {
        windup: player.playerId === sequence.pitcher ? sample.windup : 0,
        swing: player.playerId === sequence.batter ? sample.swing : 0,
        catch: player.playerId === sequence.catcher ? sample.catch : 0,
        throwSide: sequence.throwSide
      }
    }
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
