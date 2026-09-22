/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import { useFrame } from '@react-three/fiber'
import React, { useEffect, useMemo, useRef } from 'react'
import { DataTexture, type InstancedMesh, LinearFilter, Object3D } from 'three'

import type { FieldPlayer } from './fieldModel'
import { TERRAIN } from './terrain'

/** Moving contact shadows in one draw call; the stadium shadow map stays static. */
export function PlayerShadows({
  players
}: {
  players: FieldPlayer[]
}): React.ReactElement {
  const mesh = useRef<InstancedMesh>(null)
  const transform = useMemo(() => new Object3D(), [])
  const texture = useMemo(() => {
    const bytes = new Uint8Array(32 * 32 * 4)
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const d = Math.hypot((x - 15.5) / 16, (y - 15.5) / 16)
        bytes[(y * 32 + x) * 4 + 3] = Math.max(0, 1 - d) ** 1.7 * 135
      }
    const map = new DataTexture(bytes, 32, 32)
    map.magFilter = map.minFilter = LinearFilter
    map.needsUpdate = true
    return map
  }, [])
  useEffect(
    () => () => {
      texture.dispose()
    },
    [texture]
  )
  useFrame(() => {
    if (mesh.current == null) return
    players.forEach((player, i) => {
      transform.position.set(
        player.position.x + 0.5,
        TERRAIN.players - 0.01,
        player.position.z + 0.4
      )
      transform.rotation.set(-Math.PI / 2, 0, -0.35)
      transform.scale.set(9, 6, 1)
      transform.updateMatrix()
      mesh.current?.setMatrixAt(i, transform.matrix)
    })
    mesh.current.instanceMatrix.needsUpdate = true
  })
  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, players.length]}
      frustumCulled={false}
      renderOrder={1}
    >
      <planeGeometry />
      <meshBasicMaterial
        map={texture}
        transparent
        depthWrite={false}
        toneMapped={false}
      />
    </instancedMesh>
  )
}
