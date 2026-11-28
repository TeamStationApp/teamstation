/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import React from 'react'

export const DESTINATION_RADIUS = 11

/**
 * Broad target with a bright outer rim and progressively dimmer inner rings:
 * round, or `diamond` for a base (four-sided rings, a corner toward home).
 * `dim` draws it faintly, to light a place the drag may go.
 */
export function DestinationMarker({
  position,
  radius,
  color = '#ffe000',
  shape = 'ring',
  dim = false,
  name = 'destination-marker',
  visible = true
}: {
  position: [number, number, number]
  radius: number
  color?: string
  shape?: 'ring' | 'diamond'
  dim?: boolean
  name?: string
  visible?: boolean
}): React.ReactElement {
  const segments = shape === 'diamond' ? 4 : 64
  return (
    <group
      name={name}
      visible={visible}
      position={position}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={900}
    >
      {[0, 1, 2, 3, 4].map(index => (
        <mesh key={index} name="destination-ring" renderOrder={900}>
          <ringGeometry
            args={[
              radius * (0.88 - index * 0.18),
              radius * (1 - index * 0.18),
              segments,
              1,
              // A four-sided ring from 0 has a corner on each field axis,
              // as a base does seen from home: a diamond.
              0
            ]}
          />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={Math.pow(0.57, index) * (dim ? 0.6 : 1)}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  )
}
