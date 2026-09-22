/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import React from 'react'
import { Quaternion, Vector3 } from 'three'

import type { MoveDraft } from './movePreview'
import { TERRAIN } from './terrain'

export function MoveGuide({ draft }: { draft: MoveDraft }): React.ReactElement {
  const from = new Vector3(
    draft.origin.x,
    TERRAIN.players + 0.08,
    draft.origin.z
  )
  const to = new Vector3(draft.goal.x, from.y, draft.goal.z)
  const direction = to.clone().sub(from)
  const length = direction.length()
  const rotation = new Quaternion().setFromUnitVectors(
    new Vector3(0, 1, 0),
    length > 0.001 ? direction.normalize() : new Vector3(0, 1, 0)
  )
  return (
    <group name="move-preview">
      <mesh
        position={from.clone().add(to).multiplyScalar(0.5)}
        quaternion={rotation}
      >
        <cylinderGeometry args={[0.15, 0.15, Math.max(0.001, length), 6]} />
        <meshBasicMaterial color="#ffe044" toneMapped={false} />
      </mesh>
      <mesh position={to} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.65, 0.95, 24]} />
        <meshBasicMaterial color="#ffe044" toneMapped={false} />
      </mesh>
    </group>
  )
}
