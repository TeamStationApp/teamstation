/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import React from 'react'

export const DESTINATION_RADIUS = 11

/** Broad target with a bright outer rim and progressively dimmer inner rings. */
export function DestinationMarker({
  position,
  radius
}: {
  position: [number, number, number]
  radius: number
}): React.ReactElement {
  return (
    <group
      name="destination-marker"
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
              64
            ]}
          />
          <meshBasicMaterial
            color="#ffe000"
            transparent
            opacity={Math.pow(0.57, index)}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  )
}
