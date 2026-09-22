/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import React, { useLayoutEffect, useMemo, useRef } from 'react'
import { Color, type InstancedMesh, Object3D, type Texture } from 'three'

import { fieldPalette as p } from './fieldPalette'

interface Block {
  x: number
  y: number
  z: number
  width: number
  height: number
  depth: number
  angle: number
  color: string
}
/** Hundreds of repeated stadium details share one geometry and one draw call. */
function Blocks({
  blocks,
  texture,
  name
}: {
  name?: string
  blocks: Block[]
  texture?: Texture
}): React.ReactElement {
  const ref = useRef<InstancedMesh>(null)
  useLayoutEffect(() => {
    const mesh = ref.current
    if (mesh == null) return
    const transform = new Object3D()
    blocks.forEach((block, index) => {
      transform.position.set(block.x, block.y, block.z)
      transform.rotation.set(0, block.angle, 0)
      transform.scale.set(block.width, block.height, block.depth)
      transform.updateMatrix()
      mesh.setMatrixAt(index, transform.matrix)
      mesh.setColorAt(index, new Color(block.color))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor != null) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [blocks])
  return (
    <instancedMesh
      ref={ref}
      name={name}
      args={[undefined, undefined, blocks.length]}
      receiveShadow
    >
      <boxGeometry />
      <meshStandardMaterial map={texture} roughness={0.9} />
    </instancedMesh>
  )
}
export function StadiumDetails({
  texture
}: {
  texture: Texture
}): React.ReactElement {
  const structure = useMemo(() => {
    const blocks: Block[] = []
    const add = (
      angle: number,
      radius: number,
      y: number,
      width: number,
      height: number,
      depth: number,
      color: string
    ): void => {
      blocks.push({
        x: Math.sin(angle) * radius,
        z: -Math.cos(angle) * radius,
        y,
        width,
        height,
        depth,
        angle: -angle,
        color
      })
    }
    for (let i = 0; i < 32; i++) {
      const a = -Math.PI / 3.5 + (((i + 0.5) / 32) * 2 * Math.PI) / 3.5
      add(a, 118, 2, 7.1, 4, 1.2, i % 4 === 0 ? p.board : p.wall)
      add(a, 118, 4.15, 7.1, 0.3, 1.5, '#b8a269')
      for (let row = 0; row < 4; row++) {
        add(a, 124 + row * 3.1, 1.5 + row * 2.2, 7.8, 2, 3.2, p.concrete)
        add(a, 123 + row * 3.1, 3 + row * 2.2, 7.8, 0.15, 0.15, p.wall)
        if (i % 4 === 0)
          add(a, 124 + row * 3.1, 2.8 + row * 2.2, 0.7, 0.4, 3.2, '#abb09b')
      }
      add(a, 135, 11, 8, 0.2, 0.2, p.wall)
      add(a, 135, 10.2, 0.15, 1.8, 0.15, p.wall)
    }
    return blocks
  }, [])
  const seats = useMemo(() => {
    const blocks: Block[] = []
    for (let row = 0; row < 4; row++)
      for (let i = 0; i < 320; i++) {
        if (i % 40 < 3) continue
        const a = -Math.PI / 3.5 + (((i + 0.5) / 320) * 2 * Math.PI) / 3.5
        const radius = 124 + row * 3.1
        blocks.push({
          x: Math.sin(a) * radius,
          y: 3.1 + row * 2.2,
          z: -Math.cos(a) * radius,
          width: 0.55,
          height: 0.7,
          depth: 0.5,
          angle: -a,
          color: (i + row) % 7 === 0 ? '#82958a' : p.seats
        })
      }
    return blocks
  }, [])
  return (
    <group name="stadium-details">
      <Blocks name="stadium-structure" blocks={structure} texture={texture} />
      <Blocks name="stadium-seats" blocks={seats} />
      <LightBanks />
    </group>
  )
}

/** The bank and every lamp share one local coordinate system. Move halfway from
 * the old tower position toward the corresponding outer edge of the scoreboard. */
export function LightBanks(): React.ReactElement {
  return (
    <group name="light-banks">
      {[-1, 1].map(side => (
        <group
          key={side}
          name={`light-bank-${side}`}
          position={[side * 68, 0, -Math.sqrt(136 * 136 - 68 * 68)]}
          rotation={[0, side * -Math.asin(68 / 136), 0]}
        >
          <mesh position={[0, 19, 0]}>
            <cylinderGeometry args={[0.45, 0.65, 38, 8]} />
            <meshStandardMaterial color="#788780" roughness={0.8} />
          </mesh>
          <mesh position={[0, 38, 0]}>
            <boxGeometry args={[15, 5.2, 1.6]} />
            <meshStandardMaterial color="#344b44" roughness={0.8} />
          </mesh>
          {[-1, 1].map(row =>
            [-3, -2, -1, 0, 1, 2, 3].map(column => (
              <mesh
                key={`${row}-${column}`}
                name="lamp-face"
                position={[column * 1.9, 38 + row * 1.2, 0.94]}
              >
                <boxGeometry args={[1.35, 1.6, 0.16]} />
                <meshBasicMaterial color="#fff0c3" toneMapped={false} />
              </mesh>
            ))
          )}
        </group>
      ))}
    </group>
  )
}
