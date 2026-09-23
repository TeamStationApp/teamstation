/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import React, { useEffect, useState } from 'react'

import { SCOREBOARD_SCALE, SCOREBOARD_Y, SCOREBOARD_Z } from './cameraModel'
import { HomeRunLights } from './HomeRunLights'
import { DEMO_SCOREBOARD, type ScoreboardState } from './scoreboardModel'
import { makeScoreboardTexture } from './scoreboardTexture'

export function Scoreboard({
  state = DEMO_SCOREBOARD
}: {
  state?: ScoreboardState
}): React.ReactElement {
  // Built from what the board says, not from the object that says it: the
  // scoring screen hands over a new one on every render. Drawing the board
  // takes a phone 15-30 ms, so a change is drawn in a task of its own after
  // the render that brought it, rather than adding to the stall of a tap; the
  // board shows what it said until then.
  const content = JSON.stringify(state)
  const [board, setBoard] = useState(() => ({
    content,
    texture: makeScoreboardTexture(state)
  }))
  useEffect(() => {
    if (board.content === content) return
    const timer = setTimeout(() => {
      setBoard({
        content,
        texture: makeScoreboardTexture(JSON.parse(content) as ScoreboardState)
      })
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [board.content, content])
  const { texture } = board
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
