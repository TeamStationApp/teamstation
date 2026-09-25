/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import { useFrame } from '@react-three/fiber'
import React, { useRef } from 'react'
import { type Group, Quaternion, Vector3 } from 'three'

import { fieldPalette as p } from './fieldPalette'
import { PLAYER_SCALE } from './playerPresentation'
import { TERRAIN } from './terrain'

export function Bat(): React.ReactElement {
  return (
    <group>
      <mesh position={[0, 0.04, 0]}>
        <cylinderGeometry args={[0.085, 0.085, 0.08, 10]} />
        <meshStandardMaterial color="#643d20" />
      </mesh>
      <mesh position={[0, 0.36, 0]}>
        <cylinderGeometry args={[0.055, 0.045, 0.64, 10]} />
        <meshStandardMaterial color="#a76e3e" />
      </mesh>
      <mesh position={[0, 1.14, 0]}>
        <cylinderGeometry args={[0.115, 0.055, 0.92, 12]} />
        <meshStandardMaterial color="#d8a66b" roughness={0.72} />
      </mesh>
      <mesh position={[0, 1.61, 0]}>
        <sphereGeometry args={[0.115, 10, 8]} />
        <meshStandardMaterial color="#d8a66b" />
      </mesh>
    </group>
  )
}
function Limb({
  from,
  to,
  color,
  radius
}: {
  from: [number, number, number]
  to: [number, number, number]
  color: string
  radius: number
}): React.ReactElement {
  const a = new Vector3(...from)
  const b = new Vector3(...to)
  const delta = b.clone().sub(a)
  return (
    <mesh
      position={a.add(b).multiplyScalar(0.5)}
      quaternion={new Quaternion().setFromUnitVectors(
        new Vector3(0, 1, 0),
        delta.clone().normalize()
      )}
    >
      <cylinderGeometry args={[radius, radius, delta.length(), 10]} />
      <meshStandardMaterial color={color} roughness={0.85} />
    </mesh>
  )
}
export function BattingPose(): React.ReactElement {
  return (
    <group name="right-handed-batting-pose">
      <Limb
        from={[-0.56, 1.93, 0]}
        to={[-0.88, 1.52, 0.4]}
        radius={0.17}
        color={p.runner}
      />
      <Limb
        from={[-0.88, 1.52, 0.4]}
        to={[-0.45, 2.1, 0.5]}
        radius={0.13}
        color={p.skin}
      />
      <Limb
        from={[0.56, 1.93, 0]}
        to={[0.26, 1.45, 0.62]}
        radius={0.17}
        color={p.runner}
      />
      <Limb
        from={[0.26, 1.45, 0.62]}
        to={[-0.45, 1.96, 0.5]}
        radius={0.13}
        color={p.skin}
      />
      {[1.96, 2.1].map(y => (
        <mesh key={y} position={[-0.45, y, 0.5]}>
          <sphereGeometry args={[0.14, 10, 8]} />
          <meshStandardMaterial color="#f5ecd9" />
        </mesh>
      ))}
      <group
        name="held-bat"
        position={[-0.45, 1.96, 0.5]}
        rotation={[0, 0, 0.35]}
      >
        <Bat />
      </group>
    </group>
  )
}
export function DroppedBat({
  x,
  z,
  heading
}: {
  x: number
  z: number
  heading: number
}): React.ReactElement {
  const root = useRef<Group>(null)
  const elapsed = useRef(0)
  useFrame(({ invalidate }, dt) => {
    elapsed.current = Math.min(0.65, elapsed.current + Math.min(dt, 0.05))
    const t = elapsed.current / 0.65
    if (root.current != null) {
      root.current.position.set(
        x - t,
        TERRAIN.players + 0.55 + (1 - t * t) * 6.65,
        z + t * 1.2
      )
      root.current.rotation.set((t * Math.PI) / 2, heading, 0.35 * (1 - t))
    }
    if (t < 1) invalidate()
  })
  return (
    <group
      name="dropped-bat"
      ref={root}
      position={[x, TERRAIN.players + 7.2, z]}
      rotation={[0, heading, 0.35]}
      scale={PLAYER_SCALE}
    >
      <Bat />
    </group>
  )
}
