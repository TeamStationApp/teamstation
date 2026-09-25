/* eslint-disable react/no-unknown-property -- React Three Fiber elements describe Three.js objects, not HTML. */
import React, { useMemo } from 'react'
import { Shape, type Texture } from 'three'

import { Dugout } from './Dugout'
import { BASE, BASES } from './fieldModel'
import { fieldPalette as p } from './fieldPalette'
import { Scoreboard } from './Scoreboard'
import type { ScoreboardState } from './scoreboardModel'
import {
  OUTFIELD_HALF_ANGLE,
  OUTFIELD_RADIUS,
  WARNING_TRACK_INNER
} from './stadiumBoundary'
import { StadiumDetails } from './StadiumDetails'
import type { useSurfaceTextures } from './surfaceTextures'
import type { FieldTeams } from './teamUniform'
import { groundDepth, TERRAIN } from './terrain'

function sector(radius: number, inner = 0, angle = Math.PI / 4): Shape {
  const shape = new Shape()
  for (let i = 0; i <= 64; i++) {
    const a = -angle + (i / 64) * 2 * angle
    const x = Math.sin(a) * radius
    const y = Math.cos(a) * radius
    if (i === 0) shape.moveTo(x, y)
    else shape.lineTo(x, y)
  }
  for (let i = 64; i >= 0; i--) {
    const a = -angle + (i / 64) * 2 * angle
    shape.lineTo(Math.sin(a) * inner, Math.cos(a) * inner)
  }
  shape.closePath()
  return shape
}
function Polygon({
  points,
  color,
  map,
  height = TERRAIN.dirt
}: {
  points: Array<[number, number]>
  color: string
  height?: number
  map?: Texture
}): React.ReactElement {
  const shape = useMemo(() => {
    const result = new Shape()
    points.forEach(([x, z], i) =>
      i === 0 ? result.moveTo(x, -z) : result.lineTo(x, -z)
    )
    result.closePath()
    return result
  }, [points])
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, height, 0]}
      receiveShadow
    >
      <shapeGeometry args={[shape]} />
      <meshStandardMaterial
        color={color}
        map={map}
        roughness={1}
        {...groundDepth(height)}
      />
    </mesh>
  )
}
function Disc({
  x = 0,
  z = 0,
  radius,
  color,
  map,
  height = TERRAIN.plateDirt
}: {
  x?: number
  z?: number
  radius: number
  color: string
  height?: number
  map?: Texture
}): React.ReactElement {
  return (
    <mesh
      position={[x, height, z]}
      rotation={[-Math.PI / 2, 0, 0]}
      receiveShadow
    >
      <circleGeometry
        args={[radius, 48]}
        onUpdate={geometry => {
          const positions = geometry.getAttribute('position')
          const uv = geometry.getAttribute('uv')
          for (let i = 0; i < uv.count; i++)
            uv.setXY(i, positions.getX(i) + x, positions.getY(i) - z)
          uv.needsUpdate = true
        }}
      />
      <meshStandardMaterial
        color={color}
        map={map}
        roughness={1}
        {...groundDepth(height)}
      />
    </mesh>
  )
}
function Stripe({
  radius,
  map
}: {
  radius: number
  map: Texture
}): React.ReactElement {
  const shape = useMemo(() => sector(radius, radius - 6), [radius])
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, TERRAIN.stripe, 0]}
      receiveShadow
    >
      <shapeGeometry args={[shape]} />
      <meshStandardMaterial
        color={p.stripe}
        map={map}
        roughness={1}
        {...groundDepth(TERRAIN.stripe)}
      />
    </mesh>
  )
}
function Box({
  position,
  size,
  color,
  rotation = 0
}: {
  position: [number, number, number]
  size: [number, number, number]
  color: string
  rotation?: number
}): React.ReactElement {
  return (
    <mesh
      position={position}
      rotation={[0, rotation, 0]}
      castShadow
      receiveShadow
    >
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.85} />
    </mesh>
  )
}
export function Ballpark({
  textures,
  teams,
  scoreboard
}: {
  teams?: FieldTeams
  scoreboard?: ScoreboardState
  textures: ReturnType<typeof useSurfaceTextures>
}): React.ReactElement {
  const grass = useMemo(() => sector(114, 0, OUTFIELD_HALF_ANGLE), [])
  const infield = useMemo(() => sector(47.5), [])
  const track = useMemo(
    () => sector(OUTFIELD_RADIUS, WARNING_TRACK_INNER, OUTFIELD_HALF_ANGLE),
    []
  )
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.3, -45]}
        receiveShadow
      >
        <circleGeometry args={[180, 80]} />
        <meshStandardMaterial color={p.ground} map={textures.grass} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <shapeGeometry args={[grass]} />
        <meshStandardMaterial
          color={p.grass}
          map={textures.grass}
          roughness={1}
        />
      </mesh>
      {[12, 24, 36, 48, 60, 72, 84, 96, 108].map(radius => (
        <Stripe key={radius} radius={radius} map={textures.grass} />
      ))}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, TERRAIN.track, 0]}
        receiveShadow
      >
        <shapeGeometry args={[track]} />
        <meshStandardMaterial
          color={p.dirt}
          map={textures.dirt}
          roughness={1}
          {...groundDepth(TERRAIN.dirt)}
        />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, TERRAIN.dirt, 0]}
        receiveShadow
      >
        <shapeGeometry args={[infield]} />
        <meshStandardMaterial
          color={p.dirt}
          map={textures.dirt}
          roughness={1}
          {...groundDepth(TERRAIN.dirt)}
        />
      </mesh>
      <Polygon
        points={[
          [0, -4],
          [16.7, -BASE],
          [0, -35],
          [-16.7, -BASE]
        ]}
        color={p.grass}
        map={textures.grass}
        height={TERRAIN.diamond}
      />
      <Disc radius={10} color={p.dirt} map={textures.dirt} />
      <Disc
        radius={2.8}
        z={-18.44}
        color={p.clay}
        map={textures.dirt}
        height={TERRAIN.mound}
      />
      <Box
        position={[0, TERRAIN.chalk, -18.44]}
        size={[0.61, 0.1, 0.15]}
        color={p.chalk}
      />
      {BASES.slice(1).map((b, i) => (
        <Disc
          key={`wear-${i}`}
          x={b.x}
          z={b.z}
          radius={1.8}
          color={p.clay}
          map={textures.dirt}
          height={TERRAIN.wear}
        />
      ))}
      {BASES.slice(1).map((b, i) => (
        <Box
          key={i}
          position={[b.x, TERRAIN.chalk, b.z]}
          size={[0.7, 0.22, 0.7]}
          rotation={Math.PI / 4}
          color={p.chalk}
        />
      ))}
      <Polygon
        points={[
          [-0.4, -0.4],
          [0.4, -0.4],
          [0.4, 0],
          [0, 0.4],
          [-0.4, 0]
        ]}
        color={p.chalk}
        height={TERRAIN.chalk}
      />
      {[-1, 1].map(side => (
        <group key={side}>
          <Box
            position={[side * 40, TERRAIN.chalk, -40]}
            size={[0.16, 0.05, 113]}
            rotation={(side * -Math.PI) / 4}
            color={p.chalk}
          />
          {[-1, 1].map(edge => (
            <Box
              key={edge}
              position={[side * 1.6 + edge * 0.65, TERRAIN.chalk, -0.4]}
              size={[0.08, 0.03, 2.5]}
              color={p.chalk}
            />
          ))}
          {[-1.65, 0.85].map(z => (
            <Box
              key={z}
              position={[side * 1.6, TERRAIN.chalk, z]}
              size={[1.38, 0.03, 0.08]}
              color={p.chalk}
            />
          ))}
          <Box
            position={[side * 81, 8, -81]}
            size={[0.45, 16, 0.45]}
            color={p.selection}
          />
          <Dugout
            side={side === -1 ? 'away' : 'home'}
            team={teams?.[side === -1 ? 'away' : 'home']}
          />
        </group>
      ))}
      <StadiumDetails texture={textures.wall} />
      <Scoreboard state={scoreboard} />
    </group>
  )
}
