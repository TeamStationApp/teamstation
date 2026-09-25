/* eslint-disable react/no-unknown-property -- Three.js LED screen geometry. */
import { useFrame, useThree } from '@react-three/fiber'
import React, { useEffect, useMemo, useRef } from 'react'
import {
  Color,
  type DataTexture,
  type InstancedMesh,
  Matrix4,
  type MeshBasicMaterial
} from 'three'

import {
  celebrationPulse,
  FIREWORK_BULBS,
  fireworkBulb
} from './homeRunFireworks'
export function HomeRunLights({
  texture,
  paused
}: {
  texture: DataTexture
  paused: boolean
}): React.ReactElement {
  const material = useRef<MeshBasicMaterial>(null)
  const bulbs = useRef<InstancedMesh>(null)
  const time = useRef(0)
  const skip = useRef(true)
  const matrix = useMemo(() => new Matrix4(), [])
  const colors = useMemo(
    () => [
      new Color('#ffe85b'),
      new Color('#73ddff'),
      new Color('#ff93cb'),
      new Color('#ffffff')
    ],
    []
  )
  const invalidate = useThree(s => s.invalidate)
  useEffect(() => {
    skip.current = true
    invalidate()
  }, [paused, invalidate])
  useFrame((_, dt) => {
    if (!paused && !skip.current) time.current += Math.min(dt, 0.1)
    skip.current = false
    if (material.current != null)
      material.current.opacity = celebrationPulse(time.current)
    if (bulbs.current != null) {
      for (let i = 0; i < FIREWORK_BULBS; i++) {
        const point = fireworkBulb(i, time.current)
        matrix
          .makeScale(point.scale, point.scale, 1)
          .setPosition(point.x, point.y, 0.03)
        bulbs.current.setMatrixAt(i, matrix)
        bulbs.current.setColorAt(i, colors[Math.floor(i / 16)])
      }
      bulbs.current.instanceMatrix.needsUpdate = true
      if (bulbs.current.instanceColor != null)
        bulbs.current.instanceColor.needsUpdate = true
    }
    if (!paused) invalidate()
  })
  return (
    <group name="home-run-celebration" position={[0, 0, 1.04]}>
      <mesh>
        <planeGeometry args={[64, 16]} />
        <meshBasicMaterial color="#0c1b17" toneMapped={false} />
      </mesh>
      <mesh name="home-run-letters" position={[0, 0, 0.01]}>
        <planeGeometry args={[64, 16]} />
        <meshBasicMaterial
          ref={material}
          map={texture}
          transparent
          toneMapped={false}
        />
      </mesh>
      <instancedMesh
        ref={bulbs}
        name="home-run-fireworks"
        args={[undefined, undefined, FIREWORK_BULBS]}
        frustumCulled={false}
      >
        <circleGeometry args={[0.18, 8]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  )
}
