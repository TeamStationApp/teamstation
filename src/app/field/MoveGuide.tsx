/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import { useFrame } from '@react-three/fiber'
import React, { useRef } from 'react'
import { type Group, type Mesh, Quaternion, Vector3 } from 'three'

import { DESTINATION_RADIUS, DestinationMarker } from './DestinationMarker'
import type { MoveDraft } from './movePreview'
import { TERRAIN } from './terrain'

const UP = new Vector3(0, 1, 0)

/** Where the line from the draft's origin to its goal sits, and how long. */
function guideShape(draft: MoveDraft): {
  middle: Vector3
  rotation: Quaternion
  length: number
  to: Vector3
} {
  const from = new Vector3(
    draft.origin.x,
    TERRAIN.players + 0.08,
    draft.origin.z
  )
  const to = new Vector3(draft.goal.x, from.y, draft.goal.z)
  const direction = to.clone().sub(from)
  const length = direction.length()
  const rotation = new Quaternion().setFromUnitVectors(
    UP,
    length > 0.001 ? direction.normalize() : UP
  )
  return {
    middle: from.clone().add(to).multiplyScalar(0.5),
    rotation,
    length,
    to
  }
}

/**
 * The line from where a player was picked up to where the finger has them,
 * and the rings at its end.
 *
 * `live`, when given, is the drag itself: the guide follows it every frame it
 * draws, so a finger moving across the field re-renders nothing in React.
 */
export function MoveGuide({
  draft,
  live
}: {
  draft: MoveDraft
  live?: { readonly current: MoveDraft | null }
}): React.ReactElement {
  const line = useRef<Mesh>(null)
  const guide = useRef<Group>(null)
  useFrame(() => {
    const current = live?.current
    if (current == null || line.current == null || guide.current == null) return
    const shape = guideShape(current)
    line.current.visible = shape.length > 0.001
    line.current.position.copy(shape.middle)
    line.current.quaternion.copy(shape.rotation)
    line.current.scale.set(1, Math.max(0.001, shape.length), 1)
    guide.current
      .getObjectByName('destination-marker')
      ?.position.set(shape.to.x, shape.to.y, shape.to.z)
  })
  const shape = guideShape(draft)
  return (
    <group ref={guide} name="move-preview">
      <mesh
        ref={line}
        name="runner-transition-line"
        visible={shape.length > 0.001}
        position={shape.middle}
        quaternion={shape.rotation}
        scale={[1, Math.max(0.001, shape.length), 1]}
      >
        <cylinderGeometry args={[0.15, 0.15, 1, 6]} />
        <meshBasicMaterial color="#ffe044" toneMapped={false} />
      </mesh>
      <DestinationMarker
        position={[shape.to.x, shape.to.y, shape.to.z]}
        radius={DESTINATION_RADIUS}
      />
    </group>
  )
}
