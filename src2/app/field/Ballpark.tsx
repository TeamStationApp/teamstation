/* eslint-disable react/no-unknown-property -- React Three Fiber elements describe Three.js objects, not HTML. */
import React, { useMemo } from 'react'
import { Shape } from 'three'

import { BASE, BASES } from './fieldModel'
import { fieldPalette as p } from './fieldPalette'

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
  height = 0.04
}: {
  points: Array<[number, number]>
  color: string
  height?: number
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
      <meshStandardMaterial color={color} roughness={1} />
    </mesh>
  )
}
function Disc({
  x = 0,
  z = 0,
  radius,
  color,
  height = 0.07
}: {
  x?: number
  z?: number
  radius: number
  color: string
  height?: number
}): React.ReactElement {
  return (
    <mesh
      position={[x, height, z]}
      rotation={[-Math.PI / 2, 0, 0]}
      receiveShadow
    >
      <circleGeometry args={[radius, 48]} />
      <meshStandardMaterial color={color} roughness={1} />
    </mesh>
  )
}
function Stripe({ radius }: { radius: number }): React.ReactElement {
  const shape = useMemo(() => sector(radius, radius - 6), [radius])
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.015, 0]}
      receiveShadow
    >
      <shapeGeometry args={[shape]} />
      <meshStandardMaterial color={p.stripe} roughness={1} />
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
export function Ballpark(): React.ReactElement {
  const grass = useMemo(() => sector(114, 0, Math.PI / 3.5), [])
  const track = useMemo(() => sector(118, 109, Math.PI / 3.5), [])
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.3, -45]}
        receiveShadow
      >
        <circleGeometry args={[180, 80]} />
        <meshStandardMaterial color={p.ground} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <shapeGeometry args={[grass]} />
        <meshStandardMaterial color={p.grass} roughness={1} />
      </mesh>
      {[12, 24, 36, 48, 60, 72, 84, 96, 108].map(radius => (
        <Stripe key={radius} radius={radius} />
      ))}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.03, 0]}
        receiveShadow
      >
        <shapeGeometry args={[track]} />
        <meshStandardMaterial color={p.dirt} roughness={1} />
      </mesh>
      <Polygon
        points={[
          [0, 5],
          [27, -BASE],
          [0, -48],
          [-27, -BASE]
        ]}
        color={p.dirt}
      />
      <Polygon
        points={[
          [0, -6],
          [13.5, -BASE],
          [0, -33],
          [-13.5, -BASE]
        ]}
        color={p.grass}
        height={0.06}
      />
      <Disc radius={10} color={p.dirt} />
      <Disc radius={2.8} z={-18.44} color={p.clay} height={0.18} />
      <Box
        position={[0, 0.23, -18.44]}
        size={[0.61, 0.1, 0.15]}
        color={p.chalk}
      />
      {BASES.slice(1).map((b, i) => (
        <Box
          key={i}
          position={[b.x, 0.16, b.z]}
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
        height={0.1}
      />
      {[-1, 1].map(side => (
        <group key={side}>
          <Box
            position={[side * 40, 0.09, -40]}
            size={[0.16, 0.05, 113]}
            rotation={(side * -Math.PI) / 4}
            color={p.chalk}
          />
          {[-1, 1].map(edge => (
            <Box
              key={edge}
              position={[side * 1.6 + edge * 0.65, 0.1, -0.4]}
              size={[0.08, 0.03, 2.5]}
              color={p.chalk}
            />
          ))}
          {[-1.65, 0.85].map(z => (
            <Box
              key={z}
              position={[side * 1.6, 0.1, z]}
              size={[1.38, 0.03, 0.08]}
              color={p.chalk}
            />
          ))}
          <Box
            position={[side * 81, 8, -81]}
            size={[0.45, 16, 0.45]}
            color={p.selection}
          />
          <Box
            position={[side * 28, 1, 0]}
            size={[14, 2, 5]}
            rotation={(side * Math.PI) / 4}
            color={p.wall}
          />
          <Box
            position={[side * 28, 2.3, 0]}
            size={[16, 0.35, 6]}
            rotation={(side * Math.PI) / 4}
            color={p.concrete}
          />
        </group>
      ))}
      {Array.from({ length: 32 }, (_, i) => {
        const a = -Math.PI / 3.5 + ((i + 0.5) / 32) * ((2 * Math.PI) / 3.5)
        return (
          <group key={i} rotation={[0, -a, 0]}>
            <Box
              position={[0, 2, -118]}
              size={[7.1, 4, 1.2]}
              color={i % 4 === 0 ? p.board : p.wall}
            />
            <Box
              position={[0, 4.15, -118]}
              size={[7.1, 0.3, 1.5]}
              color={p.selection}
            />
            {[0, 1, 2, 3].map(row => (
              <Box
                key={row}
                position={[0, 1.5 + row * 2.2, -124 - row * 3.1]}
                size={[7.8, 2, 3.2]}
                color={row % 2 === 0 ? p.seats : p.seatsLight}
              />
            ))}
          </group>
        )
      })}
      <Box position={[0, 12, -126]} size={[30, 13, 2]} color={p.board} />
      <Box position={[0, 19, -126]} size={[32, 1, 2.5]} color={p.selection} />
      {[-8, 8].map(x => (
        <Box key={x} position={[x, 4, -126]} size={[1, 8, 1]} color={p.wall} />
      ))}
      {Array.from({ length: 9 }, (_, i) => (
        <Box
          key={i}
          position={[-12 + i * 3, 13, -124.9]}
          size={[1.1, 2, 0.1]}
          color={i === 0 ? p.runner : p.chalk}
        />
      ))}
      <Box
        position={[0, 9, -124.9]}
        size={[25, 0.4, 0.1]}
        color={p.seatsLight}
      />
    </group>
  )
}
