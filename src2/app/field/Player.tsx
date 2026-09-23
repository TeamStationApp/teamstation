/* eslint-disable react/no-unknown-property -- React Three Fiber elements describe Three.js objects, not HTML. */
import { useFrame, useThree } from '@react-three/fiber'
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Color, type Group, type Material, Mesh, type Texture } from 'three'

import { AthleteRig } from './AthleteRig'
import { BattingPose, DroppedBat } from './BattingPose'
import { advancePlayer, type FieldPlayer } from './fieldModel'
import { fieldPalette as p } from './fieldPalette'
import { makePlayerLabel } from './playerLabels'
import { PLAYER_SCALE } from './playerPresentation'
import { uniformColor } from './teamUniform'
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
  // Made again only when the number shown changes: the pitch presentation
  // hands over players whose `suppressed` is unset rather than false, and
  // keying on the flag itself made every player's number again, with its
  // upload and its shader, on every pitch.
  const shownJersey =
    player.jersey === '' || player.suppressed === true ? null : player.jersey
  const labels = useMemo(
    () => ({
      jersey: shownJersey == null ? null : makePlayerLabel(shownJersey)
    }),
    [shownJersey]
  )
  useEffect(
    () => () => {
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
  const [parts] = useState<PlayerParts>(() => ({
    root,
    body,
    leftArm,
    rightArm,
    batPose,
    leftLeg,
    rightLeg,
    target
  }))
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
  const shirt = uniformColor(player)
  useFrame((_, dt) => {
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
  // The player's position, pose and motion move him from frame to frame
  // (`useFrame` above, and the rig's); his body is drawn again only when
  // what it is made of changes. Reconciling every player's forty-odd parts on
  // each change of the field cost a phone about 15 ms of the frame a pitch
  // starts on.
  const latest = useRef(player)
  latest.current = player
  const x = player.position.x
  const z = player.position.z
  const placed = useRef({ x, z })
  useLayoutEffect(() => {
    if (placed.current.x === x && placed.current.z === z) return
    placed.current = { x, z }
    root.current?.position.set(x, TERRAIN.players, z)
    invalidate()
  }, [x, z, invalidate])
  return (
    <PlayerBody
      id={player.id}
      start={placed.current}
      shirt={shirt}
      fabric={fabric}
      jersey={labels.jersey}
      batting={batting}
      batSide={player.batSide}
      team={player.team}
      hasBall={player.hasBall === true}
      receivingBall={player.receivingBall === true}
      selected={selected}
      droppedX={player.droppedBat?.x}
      droppedZ={player.droppedBat?.z}
      droppedHeading={player.droppedBat?.heading}
      source={latest}
      parts={parts}
    />
  )
}

interface PlayerParts {
  root: React.RefObject<Group | null>
  body: React.RefObject<Group | null>
  leftArm: React.RefObject<Group | null>
  rightArm: React.RefObject<Group | null>
  batPose: React.RefObject<Group | null>
  leftLeg: React.RefObject<Group | null>
  rightLeg: React.RefObject<Group | null>
  target: React.RefObject<Mesh | null>
}

interface PlayerBodyProps {
  id: string
  /** Where he stood when first drawn; `Player` moves him from there. */
  start: { x: number; z: number }
  shirt: string
  fabric?: Texture
  jersey: Texture | null
  batting: boolean
  batSide?: FieldPlayer['batSide']
  team: FieldPlayer['team']
  hasBall: boolean
  receivingBall: boolean
  selected: boolean
  droppedX?: number
  droppedZ?: number
  droppedHeading?: number
  source: { current: FieldPlayer }
  parts: PlayerParts
}

/** Everything but where he stands: `start` is read only when first drawn. */
function samePlayerBody(a: PlayerBodyProps, b: PlayerBodyProps): boolean {
  for (const key of Object.keys(a) as Array<keyof PlayerBodyProps>)
    if (key !== 'start' && a[key] !== b[key]) return false
  return true
}

const PlayerBody = React.memo(function PlayerBody({
  id,
  start,
  shirt,
  fabric,
  jersey,
  batting,
  batSide,
  team,
  hasBall,
  receivingBall,
  selected,
  droppedX,
  droppedZ,
  droppedHeading,
  source,
  parts
}: PlayerBodyProps): React.ReactElement {
  const { root, body, leftArm, rightArm, batPose, leftLeg, rightLeg, target } =
    parts
  const droppedBat =
    droppedX == null || droppedZ == null || droppedHeading == null
      ? null
      : { x: droppedX, z: droppedZ, heading: droppedHeading }
  return (
    <>
      <group
        name={`player-${id}`}
        ref={root}
        position={[start.x, TERRAIN.players, start.z]}
      >
        {(hasBall || receivingBall) &&
          [0, 1, 2, 3].map(index => (
            <mesh
              key={`possession-${index}`}
              name={receivingBall ? 'receiving-ring' : 'possession-ring'}
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, 0.04 + index * 0.003, 0]}
            >
              <ringGeometry args={[2 + index, 2.35 + index, 48]} />
              <meshBasicMaterial
                color="#ffffff"
                transparent
                opacity={1 - index * 0.17}
                depthWrite={false}
              />
            </mesh>
          ))}
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
        <AthleteRig source={source} shirt={shirt} jersey={jersey} />
        <group ref={body} scale={[PLAYER_SCALE, PLAYER_SCALE, PLAYER_SCALE]}>
          <mesh
            name="jersey-torso"
            position={[0, 1.57, 0]}
            scale={[1, 1, 0.62]}
          >
            <cylinderGeometry args={[0.43, 0.33, 0.97, 10]} />
            <meshStandardMaterial color={shirt} map={fabric} roughness={0.85} />
          </mesh>
          {jersey != null &&
            [-1, 1].map(side => (
              <mesh
                key={side}
                name="jersey-number"
                position={[0, 1.63, side * 0.32]}
                rotation={[0, side === -1 ? Math.PI : 0, 0]}
              >
                <planeGeometry args={[0.6, 0.65]} />
                <meshBasicMaterial
                  map={jersey}
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
            <group ref={batPose} scale={[batSide === 'L' ? -1 : 1, 1, 1]}>
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
              {team === 'defense' && (
                <Part
                  position={[0, -0.84, 0.17]}
                  size={[0.5, 0.4, 0.45]}
                  rounded
                  color={p.dirt}
                />
              )}
            </group>
            <group ref={rightArm} position={[0.56, 1.93, 0]}>
              {hasBall && (
                <mesh name="possession-ball" position={[0, -0.84, 0.17]}>
                  <sphereGeometry args={[0.25, 12, 8]} />
                  <meshStandardMaterial color="#fff7de" />
                </mesh>
              )}
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
      {droppedBat != null && <DroppedBat {...droppedBat} />}
      <mesh ref={target} visible={false} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.8, 1.1, 24]} />
        <meshBasicMaterial color={p.selection} />
      </mesh>
    </>
  )
}, samePlayerBody)
