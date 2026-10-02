/* eslint-disable react/no-unknown-property -- Procedural Three.js skeleton. */
import { useFrame } from '@react-three/fiber'
import React, { useRef } from 'react'
import { type Group, Quaternion, type Texture, Vector3 } from 'three'

import type { AthletePose, Joint } from './athletePose'
import { Bat } from './BattingPose'
import type { FieldPlayer } from './fieldModel'
import { fieldPalette as p } from './fieldPalette'
import { PLAYER_SCALE } from './playerPresentation'

/**
 * Joint endpoints and the displayed bat use exactly the same sampled pose.
 * The pose is read each frame from the player `source` holds now, so the rig
 * is not drawn again when only the player moves.
 */
export function AthleteRig({
  source,
  shirt,
  jersey
}: {
  source: { current: FieldPlayer }
  shirt: string
  jersey?: Texture | null
}): React.ReactElement {
  const root = useRef<Group>(null)
  const unitY = new Vector3(0, 1, 0)
  useFrame(() => {
    const player = source.current
    const pose: AthletePose | undefined = player.pose?.athlete
    if (root.current == null) return
    root.current.visible = pose != null
    if (pose == null) return
    root.current.rotation.y = player.pose?.athleteHeading ?? 0
    const set = (name: string, from: Joint, to: Joint): void => {
      const object = root.current!.getObjectByName(name)!
      const a = new Vector3(...from)
      const b = new Vector3(...to)
      object.position.copy(a).add(b).multiplyScalar(0.5)
      object.scale.y = a.distanceTo(b)
      object.quaternion.copy(
        new Quaternion().setFromUnitVectors(unitY, b.sub(a).normalize())
      )
    }
    for (const i of [0, 1]) {
      set(`upper-arm-${i}`, pose.shoulders[i], pose.elbows[i])
      set(`forearm-${i}`, pose.elbows[i], pose.hands[i])
      const hip: Joint = [i === 0 ? -0.23 : 0.23, 1.02, 0]
      set(`thigh-${i}`, hip, pose.knees[i])
      set(`shin-${i}`, pose.knees[i], pose.feet[i])
      root.current.getObjectByName(`hand-${i}`)!.position.set(...pose.hands[i])
      root.current.getObjectByName(`shoe-${i}`)!.position.set(...pose.feet[i])
    }
    const torso = root.current.getObjectByName('animated-torso')!
    torso.rotation.set(pose.lean, pose.torso, 0)
    root.current.getObjectByName('animated-pelvis')!.rotation.y = pose.pelvis
    const bat = root.current.getObjectByName('animated-bat')!
    bat.visible = pose.bat != null
    if (pose.bat != null) {
      bat.position.set(...pose.bat.knob)
      bat.quaternion.copy(
        new Quaternion().setFromUnitVectors(
          unitY,
          new Vector3(...pose.bat.direction)
        )
      )
    }
  })
  return (
    <group name="athlete-rig" ref={root} scale={PLAYER_SCALE} visible={false}>
      <group name="animated-torso" position={[0, 1.57, 0]}>
        <mesh scale={[1, 1, 0.62]}>
          <cylinderGeometry args={[0.43, 0.33, 0.97, 10]} />
          <meshStandardMaterial color={shirt} />
        </mesh>
        <mesh position={[0, 0.77, 0]}>
          <sphereGeometry args={[0.35, 12, 10]} />
          <meshStandardMaterial color={p.skin} />
        </mesh>
        <mesh position={[0, 0.95, 0]}>
          <sphereGeometry
            args={[0.37, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]}
          />
          <meshStandardMaterial color={shirt} />
        </mesh>
        <mesh position={[0, 0.94, 0.27]}>
          <boxGeometry args={[0.65, 0.09, 0.45]} />
          <meshStandardMaterial color={shirt} />
        </mesh>
        {jersey != null &&
          [-1, 1].map(side => (
            <mesh
              key={side}
              position={[0, 0.06, side * 0.32]}
              rotation={[0, side === -1 ? Math.PI : 0, 0]}
            >
              <planeGeometry args={[0.6, 0.65]} />
              <meshBasicMaterial
                map={jersey}
                transparent
                alphaTest={0.1}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          ))}
      </group>
      <mesh name="animated-pelvis" position={[0, 1.08, 0]}>
        <boxGeometry args={[0.82, 0.16, 0.5]} />
        <meshStandardMaterial color={p.shoes} />
      </mesh>
      {[0, 1].map(i => (
        <group key={i}>
          {['upper-arm', 'forearm', 'thigh', 'shin'].map(part => (
            <mesh key={part} name={`${part}-${i}`}>
              <cylinderGeometry
                args={[
                  part === 'forearm' ? 0.13 : 0.17,
                  part === 'forearm' ? 0.13 : 0.17,
                  1,
                  10
                ]}
              />
              <meshStandardMaterial
                color={
                  part === 'upper-arm'
                    ? shirt
                    : part === 'forearm'
                      ? p.skin
                      : p.pants
                }
              />
            </mesh>
          ))}
          <mesh name={`hand-${i}`}>
            <sphereGeometry args={[0.14, 10, 8]} />
            <meshStandardMaterial color={p.skin} />
          </mesh>
          <mesh name={`shoe-${i}`}>
            <boxGeometry args={[0.43, 0.27, 0.68]} />
            <meshStandardMaterial color={p.shoes} />
          </mesh>
        </group>
      ))}
      <group name="animated-bat">
        <Bat />
      </group>
    </group>
  )
}
