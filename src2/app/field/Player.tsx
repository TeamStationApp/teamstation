/* eslint-disable react/no-unknown-property -- React Three Fiber elements describe Three.js objects, not HTML. */
import { useFrame, useThree } from '@react-three/fiber'
import React, { useEffect, useMemo, useRef } from 'react'
import {
  Color,
  type Group,
  type Material,
  Mesh,
  PerspectiveCamera,
  type Sprite,
  type Texture
} from 'three'

import { AthleteRig } from './AthleteRig'
import { BattingPose, DroppedBat } from './BattingPose'
import { advancePlayer, type FieldPlayer } from './fieldModel'
import { fieldPalette as p } from './fieldPalette'
import { makePlayerLabel } from './playerLabels'
import {
  hasPlayerLabel,
  placePlayerLabel,
  PLAYER_SCALE
} from './playerPresentation'
import { TERRAIN } from './terrain'

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
  fabric,
  onMovementComplete,
  paused = false
}: {
  player: FieldPlayer
  selected: boolean
  paused?: boolean
  fabric?: Texture
  onMovementComplete?: (id: string, generation: number) => void
}): React.ReactElement {
  const batting = player.batting === true
  const invalidate = useThree(state => state.invalidate)
  const label = useRef<Sprite>(null)
  const showLabel = player.suppressed !== true && hasPlayerLabel(player)
  const labels = useMemo(
    () => ({
      badge: showLabel ? makePlayerLabel(player.displayName, true) : null,
      jersey:
        player.jersey === '' || player.suppressed === true
          ? null
          : makePlayerLabel(player.jersey, false)
    }),
    [player.jersey, player.displayName, player.suppressed, showLabel]
  )
  useEffect(
    () => () => {
      labels.badge?.dispose()
      labels.jersey?.dispose()
    },
    [labels]
  )
  const root = useRef<Group>(null)
  const body = useRef<Group>(null)
  const leftArm = useRef<Group>(null)
  const rightArm = useRef<Group>(null)
  const batPose = useRef<Group>(null)
  const leftLeg = useRef<Group>(null)
  const rightLeg = useRef<Group>(null)
  const target = useRef<Mesh>(null)
  useEffect(() => {
    if (player.suppressed !== true) return
    const originals = new Map<
      Material,
      { opacity: number; transparent: boolean; color?: Color }
    >()
    root.current?.traverse(object => {
      if (!(object instanceof Mesh)) return
      for (const material of Array.isArray(object.material)
        ? object.material
        : [object.material]) {
        const color =
          'color' in material && material.color instanceof Color
            ? material.color
            : undefined
        originals.set(material, {
          opacity: material.opacity,
          transparent: material.transparent,
          color: color?.clone()
        })
        material.opacity = 0.5
        material.transparent = true
        material.needsUpdate = true
      }
    })
    invalidate()
    return () => {
      for (const [material, before] of originals) {
        material.opacity = before.opacity
        material.transparent = before.transparent
        if (
          before.color != null &&
          'color' in material &&
          material.color instanceof Color
        )
          material.color.copy(before.color)
        material.needsUpdate = true
      }
    }
  }, [player.suppressed, invalidate])
  const shirt = player.team === 'runner' ? p.runner : p.defense
  useFrame(({ camera, size }, dt) => {
    if (!paused && player.pose?.run == null) advancePlayer(player, dt)
    const motion = player.motion
    if (
      !paused &&
      motion != null &&
      !motion.reported &&
      Math.hypot(
        player.position.x - player.target.x,
        player.position.z - player.target.z
      ) < 0.04
    ) {
      if (motion.index + 1 < motion.waypoints.length) {
        motion.index++
        player.target = { ...motion.waypoints[motion.index] }
        invalidate()
      } else {
        motion.reported = true
        onMovementComplete?.(motion.id, motion.generation)
      }
    }
    if (player.speed > 0 && !paused) invalidate()
    if (root.current == null || body.current == null) return
    root.current.position.set(
      player.position.x,
      TERRAIN.players,
      player.position.z
    )
    if (label.current != null && camera instanceof PerspectiveCamera) {
      placePlayerLabel(label.current, player, camera, size.height)
    }
    body.current.visible = player.pose?.athlete == null
    body.current.rotation.y = player.heading
    const running = player.pose?.run ?? Math.min(1, player.speed / 5)
    const swing = Math.sin(player.stride) * 0.8 * running
    if (leftArm.current != null) leftArm.current.rotation.x = swing
    if (rightArm.current != null) rightArm.current.rotation.x = -swing
    if (leftLeg.current != null) leftLeg.current.rotation.x = -swing
    if (rightLeg.current != null) rightLeg.current.rotation.x = swing
    body.current.position.y = batting
      ? -0.09
      : Math.abs(Math.cos(player.stride)) * 0.13 * running
    body.current.rotation.x = running * 0.12
    if (player.pose != null) {
      const {
        windup,
        catch: catching,
        throwSide,
        swing: batSwing
      } = player.pose
      const throwingArm = throwSide === 'R' ? rightArm.current : leftArm.current
      if (throwingArm != null) throwingArm.rotation.x -= windup * 2.7
      if (leftArm.current != null) leftArm.current.rotation.x -= catching * 0.8
      body.current.rotation.x -= windup * 0.18
      if (batPose.current != null) {
        batPose.current.rotation.y = batSwing * 0.4
        const bat = batPose.current.getObjectByName('held-bat')
        if (bat != null) {
          bat.rotation.x = -1.4 * batSwing
          bat.rotation.z = 0.35 * (1 - batSwing)
        }
      }
    } else if (batPose.current != null) {
      batPose.current.rotation.y = 0
      const bat = batPose.current.getObjectByName('held-bat')
      if (bat != null) {
        bat.rotation.x = 0
        bat.rotation.z = 0.35
      }
    }
    if (target.current != null) {
      target.current.position.set(
        player.target.x,
        TERRAIN.players + 0.03,
        player.target.z
      )
      target.current.visible = selected && player.speed > 0.1
    }
  })
  return (
    <>
      <group
        name={`player-${player.id}`}
        ref={root}
        position={[player.position.x, TERRAIN.players, player.position.z]}
      >
        {selected &&
          [0, 1, 2, 3].map(index => (
            <mesh
              key={index}
              name="active-grab-ring"
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, 0.02 + index * 0.002, 0]}
            >
              <ringGeometry args={[1.3 + index, 2.3 + index, 48]} />
              <meshBasicMaterial
                color={p.selection}
                transparent
                opacity={0.15 + index * 0.2}
                depthWrite={false}
              />
            </mesh>
          ))}
        {labels.badge != null && (
          <sprite
            ref={label}
            position={[0, 12, 0]}
            scale={[0, 0, 1]}
            renderOrder={player.labelOrder ?? 5}
            name={`player-label-${player.id}`}
          >
            <spriteMaterial
              map={labels.badge}
              depthTest={false}
              transparent
              depthWrite={false}
              toneMapped={false}
            />
          </sprite>
        )}
        <AthleteRig player={player} jersey={labels.jersey} />
        <group ref={body} scale={[PLAYER_SCALE, PLAYER_SCALE, PLAYER_SCALE]}>
          <mesh
            name="jersey-torso"
            position={[0, 1.57, 0]}
            scale={[1, 1, 0.62]}
          >
            <cylinderGeometry args={[0.43, 0.33, 0.97, 10]} />
            <meshStandardMaterial color={shirt} map={fabric} roughness={0.85} />
          </mesh>
          {labels.jersey != null &&
            [-1, 1].map(side => (
              <mesh
                key={side}
                name="jersey-number"
                position={[0, 1.63, side * 0.32]}
                rotation={[0, side === -1 ? Math.PI : 0, 0]}
              >
                <planeGeometry args={[0.6, 0.65]} />
                <meshBasicMaterial
                  map={labels.jersey}
                  transparent
                  alphaTest={0.1}
                  polygonOffset
                  polygonOffsetFactor={-2}
                  polygonOffsetUnits={-2}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
            ))}
          <Part
            position={[0, 1.08, 0]}
            size={[0.82, 0.16, 0.5]}
            color={p.shoes}
          />
          <group rotation={[0, batting ? Math.PI / 2 : 0, 0]}>
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
          </group>
          {batting && (
            <group
              ref={batPose}
              scale={[player.batSide === 'L' ? -1 : 1, 1, 1]}
            >
              <BattingPose />
            </group>
          )}
          <group visible={!batting}>
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
          </group>
          <group
            ref={leftLeg}
            position={[batting ? -0.38 : -0.23, 1.02, 0]}
            rotation={[0, 0, batting ? -0.1 : 0]}
          >
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
          <group
            ref={rightLeg}
            position={[batting ? 0.38 : 0.23, 1.02, 0]}
            rotation={[0, 0, batting ? 0.1 : 0]}
          >
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
      {player.droppedBat != null && <DroppedBat {...player.droppedBat} />}
      <mesh ref={target} visible={false} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.8, 1.1, 24]} />
        <meshBasicMaterial color={p.selection} />
      </mesh>
    </>
  )
}
