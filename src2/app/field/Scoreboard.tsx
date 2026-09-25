/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import React, { useEffect, useMemo } from 'react'

import { SCOREBOARD_SCALE, SCOREBOARD_Y, SCOREBOARD_Z } from './cameraModel'
import { HomeRunLights } from './HomeRunLights'
import { DEMO_SCOREBOARD, type ScoreboardState } from './scoreboardModel'
import { makeScoreboardTexture } from './scoreboardTexture'

export function Scoreboard({
  state = DEMO_SCOREBOARD
}: {
  state?: ScoreboardState
}): React.ReactElement {
  const texture = useMemo(() => makeScoreboardTexture(state), [state])
  useEffect(
    () => () => {
      texture.dispose()
    },
    [texture]
  )
  return (
    <group
      name="vintage-scoreboard"
      position={[0, SCOREBOARD_Y, SCOREBOARD_Z]}
      scale={SCOREBOARD_SCALE}
    >
      <mesh castShadow>
        <boxGeometry args={[66, 18, 2]} />
        <meshStandardMaterial color="#17372f" roughness={0.85} />
      </mesh>
      <mesh
        visible={state.celebration == null}
        position={[0, 0, 1.02]}
        name="scoreboard-bulbs"
      >
        <planeGeometry args={[64, 16]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      {state.celebration != null && (
        <HomeRunLights
          key={state.celebration.id}
          texture={texture}
          paused={state.celebration.paused}
        />
      )}
      {[-1, 1].map(side => (
        <group key={side}>
          <mesh position={[side * 33, 0, 1]}>
            <boxGeometry args={[0.8, 18.4, 1]} />
            <meshStandardMaterial color="#63735b" roughness={0.75} />
          </mesh>
          <mesh position={[0, side * 9, 1]}>
            <boxGeometry args={[67, 0.8, 1]} />
            <meshStandardMaterial color="#63735b" roughness={0.75} />
          </mesh>
          <mesh position={[side * 23, -12.3, -0.4]} castShadow>
            <boxGeometry args={[1.4, 6.7, 1.5]} />
            <meshStandardMaterial color="#33483d" />
          </mesh>
          <mesh
            position={[side * 23, -12, -0.6]}
            rotation={[0, 0, side * 0.55]}
          >
            <boxGeometry args={[0.6, 7, 0.6]} />
            <meshStandardMaterial color="#33483d" />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 9.7, 0.4]} castShadow>
        <boxGeometry args={[69, 0.5, 5]} />
        <meshStandardMaterial color="#283b32" roughness={0.8} />
      </mesh>
    </group>
  )
}
