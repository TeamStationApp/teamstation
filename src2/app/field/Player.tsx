/* eslint-disable react/no-unknown-property -- React Three Fiber elements describe Three.js objects, not HTML. */
import { useFrame, useThree } from '@react-three/fiber'
import React, { useRef } from 'react'
import type { Group, Mesh, Texture } from 'three'

import { advancePlayer, type FieldPlayer } from './fieldModel'
import { fieldPalette as p } from './fieldPalette'

function Part({
  position,
  size,
  color,
  rounded = false,
  map
}: {
  position: [number, number, number]
  size: [number, number, number]
  color: string
  rounded?: boolean
  map?: Texture
}): React.ReactElement {
  return (
    <mesh position={position} scale={size}>
      {rounded ? (
        <sphereGeometry args={[0.5, 10, 8]} />
      ) : (
        <boxGeometry args={[1, 1, 1]} />
      )}
      <meshStandardMaterial color={color} map={map} roughness={0.85} />
    </mesh>
  )
}

/** Procedural articulated players: all geometry and animation also work in R3F/native. */
export function Player({
  player,
  selected,
  fabric
}: {
  player: FieldPlayer
  selected: boolean
  fabric?: Texture
}): React.ReactElement {
  const invalidate = useThree(state => state.invalidate)
  const root = useRef<Group>(null)
  const body = useRef<Group>(null)
  const leftArm = useRef<Group>(null)
  const rightArm = useRef<Group>(null)
  const leftLeg = useRef<Group>(null)
  const rightLeg = useRef<Group>(null)
  const target = useRef<Mesh>(null)
  const shirt = player.team === 'runner' ? p.runner : p.defense
  useFrame((_, dt) => {
    advancePlayer(player, dt)
    if (player.speed > 0) invalidate()
    if (root.current == null || body.current == null) return
    root.current.position.set(player.position.x, 0.2, player.position.z)
    body.current.rotation.y = player.heading
    const running = Math.min(1, player.speed / 5)
    const swing = Math.sin(player.stride) * 0.8 * running
    if (leftArm.current != null) leftArm.current.rotation.x = swing
    if (rightArm.current != null) rightArm.current.rotation.x = -swing
    if (leftLeg.current != null) leftLeg.current.rotation.x = -swing
    if (rightLeg.current != null) rightLeg.current.rotation.x = swing
    body.current.position.y = Math.abs(Math.cos(player.stride)) * 0.13 * running
    body.current.rotation.x = running * 0.12
    if (target.current != null) {
      target.current.position.set(player.target.x, 0.3, player.target.z)
      target.current.visible = selected && player.speed > 0.1
    }
  })
  return (
    <>
      <group
        name={`player-${player.id}`}
        ref={root}
        position={[player.position.x, 0.2, player.position.z]}
      >
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={selected ? [1.8, 2.15, 32] : [1.1, 1.4, 24]} />
          <meshBasicMaterial color={selected ? p.selection : shirt} />
        </mesh>
        <group ref={body} scale={1.6}>
          <mesh position={[0, 1.57, 0]} scale={[1, 1, 0.62]}>
            <cylinderGeometry args={[0.43, 0.33, 0.97, 10]} />
            <meshStandardMaterial color={shirt} map={fabric} roughness={0.85} />
          </mesh>
          <Part
            position={[0, 1.08, 0]}
            size={[0.82, 0.16, 0.5]}
            color={p.shoes}
          />
          <mesh position={[0, 2.34, 0]}>
            <sphereGeometry args={[0.35, 12, 10]} />
            <meshStandardMaterial color={p.skin} />
          </mesh>
          <mesh position={[0, 2.52, 0]}>
            <sphereGeometry
              args={[0.37, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]}
            />
            <meshStandardMaterial color={shirt} />
          </mesh>
          <Part
            position={[0, 2.51, 0.27]}
            size={[0.65, 0.09, 0.45]}
            color={shirt}
          />
          <Part
            position={[0, 1.75, 0.26]}
            size={[0.11, 0.54, 0.025]}
            color={p.chalk}
          />
          <group ref={leftArm} position={[-0.56, 1.93, 0]}>
            <Part
              position={[0, -0.22, 0]}
              size={[0.36, 0.6, 0.4]}
              rounded
              map={fabric}
              color={shirt}
            />
            <Part
              position={[0, -0.6, 0.13]}
              size={[0.29, 0.5, 0.29]}
              rounded
              color={p.skin}
            />
            {player.team === 'defense' && (
              <Part
                position={[0, -0.84, 0.17]}
                size={[0.5, 0.4, 0.45]}
                rounded
                color={p.dirt}
              />
            )}
          </group>
          <group ref={rightArm} position={[0.56, 1.93, 0]}>
            <Part
              position={[0, -0.22, 0]}
              size={[0.36, 0.6, 0.4]}
              rounded
              map={fabric}
              color={shirt}
            />
            <Part
              position={[0, -0.6, 0.13]}
              size={[0.29, 0.5, 0.29]}
              rounded
              color={p.skin}
            />
          </group>
          <group ref={leftLeg} position={[-0.23, 1.02, 0]}>
            <Part
              position={[0, -0.42, 0]}
              size={[0.4, 1.02, 0.43]}
              rounded
              map={fabric}
              color={p.pants}
            />
            <Part
              position={[0, -0.9, 0.12]}
              size={[0.43, 0.27, 0.68]}
              rounded
              color={p.shoes}
            />
          </group>
          <group ref={rightLeg} position={[0.23, 1.02, 0]}>
            <Part
              position={[0, -0.42, 0]}
              size={[0.4, 1.02, 0.43]}
              rounded
              map={fabric}
              color={p.pants}
            />
            <Part
              position={[0, -0.9, 0.12]}
              size={[0.43, 0.27, 0.68]}
              rounded
              color={p.shoes}
            />
          </group>
        </group>
      </group>
      <mesh ref={target} visible={false} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.8, 1.1, 24]} />
        <meshBasicMaterial color={p.selection} />
      </mesh>
    </>
  )
}
