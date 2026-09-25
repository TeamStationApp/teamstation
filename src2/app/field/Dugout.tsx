/* eslint-disable react/no-unknown-property -- React Three Fiber scene elements. */
import React from 'react'

import { fieldPalette as p } from './fieldPalette'
import { type FieldTeam, TEAM_COLORS } from './teamUniform'
import { useTeamLogo } from './useTeamLogo'

export function Dugout({
  side,
  team
}: {
  side: 'away' | 'home'
  team?: FieldTeam
}): React.ReactElement {
  const sign = side === 'away' ? -1 : 1
  const color = TEAM_COLORS[side]
  const logo = useTeamLogo(team?.logoUrl)
  return (
    <group
      name={`dugout-${side}`}
      position={[sign * 28, 0, 0]}
      rotation={[0, (sign * Math.PI) / 4, 0]}
    >
      <group name="dugout-opening" rotation={[0, Math.PI, 0]}>
        <mesh
          name="dugout-back"
          position={[0, 3, -2.5]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[14, 6, 0.4]} />
          <meshStandardMaterial color={p.wall} />
        </mesh>
        {[-1, 1].map(edge => (
          <mesh key={edge} position={[edge * 7, 3, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.4, 6, 5]} />
            <meshStandardMaterial color={p.wall} />
          </mesh>
        ))}
        <mesh
          name="dugout-rail"
          position={[0, 1.25, 2.7]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[14, 2.5, 0.4]} />
          <meshStandardMaterial color={color} />
        </mesh>
        <mesh
          name="dugout-roof"
          position={[0, 6.7, 0.4]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[16, 0.35, 5.2]} />
          <meshStandardMaterial color={p.concrete} />
        </mesh>
        {[-4.5, 0, 4.5].map((x, index) => (
          <group
            name={`dugout-player-${side}-${index}`}
            key={x}
            position={[x, 2.5, 3]}
          >
            <mesh
              name="dugout-shoulders"
              position={[0, 0.9, 1]}
              rotation={[0.6, 0, 0]}
              castShadow
            >
              <boxGeometry args={[2.2, 1.8, 1.1]} />
              <meshStandardMaterial color={color} />
            </mesh>
            <mesh name="dugout-head" position={[0, 2.35, 2.2]} castShadow>
              <sphereGeometry args={[0.7, 12, 10]} />
              <meshStandardMaterial color={p.skin} />
            </mesh>
            <mesh name="dugout-cap" position={[0, 2.6, 2.2]} castShadow>
              <sphereGeometry
                args={[0.74, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]}
              />
              <meshStandardMaterial color={color} />
            </mesh>
            <mesh name="dugout-brim" position={[0, 2.63, 2.7]}>
              <boxGeometry args={[1.2, 0.15, 1]} />
              <meshStandardMaterial color={color} />
            </mesh>
          </group>
        ))}
      </group>
      {logo != null && (
        <mesh
          name={`dugout-logo-${side}`}
          position={[0, 6.89, -0.4]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[4.5, 4.5]} />
          <meshBasicMaterial
            map={logo}
            transparent
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  )
}
