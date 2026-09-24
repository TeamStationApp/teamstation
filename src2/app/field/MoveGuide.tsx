/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import React from 'react'
import { Quaternion, Vector3 } from 'three'

import { DESTINATION_RADIUS, DestinationMarker } from './DestinationMarker'
import type { MoveDraft } from './movePreview'
import { TERRAIN } from './terrain'

export function MoveGuide({ draft }: { draft: MoveDraft }): React.ReactElement {
  const from = new Vector3(
    draft.origin.x,
    TERRAIN.players + 0.08,
    draft.origin.z
  )
  const destination = draft.goal
  const marker = destination
  const to = new Vector3(destination.x, from.y, destination.z)
  const direction = to.clone().sub(from)
  const length = direction.length()
  const rotation = new Quaternion().setFromUnitVectors(
    new Vector3(0, 1, 0),
    length > 0.001 ? direction.normalize() : new Vector3(0, 1, 0)
  )
  return (
    <group name="move-preview">
      <mesh
        name="runner-transition-line"
        visible={length > 0.001}
        position={from.clone().add(to).multiplyScalar(0.5)}
        quaternion={rotation}
      >
        <cylinderGeometry args={[0.15, 0.15, Math.max(0.001, length), 6]} />
        <meshBasicMaterial color="#ffe044" toneMapped={false} />
      </mesh>
      <DestinationMarker
        position={[marker.x, to.y, marker.z]}
        radius={DESTINATION_RADIUS}
      />
    </group>
  )
}
