/* eslint-disable react/no-unknown-property -- React Three Fiber elements describe Three.js objects, not HTML. */
import { type ThreeEvent, useThree } from '@react-three/fiber'
import React, { useEffect, useMemo, useRef } from 'react'
import { PerspectiveCamera, Plane, Vector3 } from 'three'

import { Ballpark } from './Ballpark'
import { applyFieldCamera } from './cameraModel'
import { type FieldPlayer, setDestination } from './fieldModel'
import { fieldPalette as p } from './fieldPalette'
import type { FieldCanvasProps } from './fieldTypes'
import { Player } from './Player'
import { PlayerShadows } from './PlayerShadows'
import { useSurfaceTextures } from './surfaceTextures'

/** Scene is renderer-independent. Only the canvas adapter owns browser APIs. */
export function FieldScene(props: FieldCanvasProps): React.ReactElement {
  const {
    players,
    selected,
    onSelect,
    view,
    zoom,
    cameraTilt = 0,
    cameraHeight = 0
  } = props
  const { camera, size, gl, invalidate } = useThree()
  const textures = useSurfaceTextures()
  useEffect(() => {
    invalidate()
  }, [invalidate, props.movementRevision])
  useEffect(() => {
    gl.shadowMap.autoUpdate = false
    gl.shadowMap.needsUpdate = true
  }, [gl])
  const drag = useRef<{ id: string; pointer: number } | null>(null)
  const ground = useMemo(() => new Plane(new Vector3(0, 1, 0), -0.25), [])
  const point = useMemo(() => new Vector3(), [])
  useEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return
    applyFieldCamera(camera, {
      width: size.width,
      height: size.height,
      view,
      zoom,
      tilt: cameraTilt,
      heightOffset: cameraHeight
    })
    invalidate()
  }, [
    camera,
    size.width,
    size.height,
    view,
    zoom,
    cameraTilt,
    cameraHeight,
    invalidate
  ])

  const move = (event: ThreeEvent<PointerEvent>, id: string): void => {
    const player = players.find(item => item.id === id)
    if (player == null || event.ray.intersectPlane(ground, point) == null)
      return
    setDestination(player, point)
    invalidate()
  }
  const down = (event: ThreeEvent<PointerEvent>): void => {
    if (view === 'scoreboard' || drag.current != null || event.button !== 0)
      return
    event.stopPropagation()
    // Screen-space targets stay finger-sized even for distant outfielders.
    let nearest: FieldPlayer | undefined
    let best = 34
    for (const player of players) {
      point.set(player.position.x, 2.5, player.position.z).project(camera)
      const dx = ((point.x - event.pointer.x) * size.width) / 2
      const dy = ((point.y - event.pointer.y) * size.height) / 2
      const distance = Math.hypot(dx, dy)
      if (distance < best) {
        nearest = player
        best = distance
      }
    }
    const id = nearest?.id ?? selected
    onSelect(id)
    drag.current = { id, pointer: event.pointerId }
    const capture = event.target as Element
    capture.setPointerCapture(event.pointerId)
    if (nearest == null) move(event, id)
  }
  const up = (event: ThreeEvent<PointerEvent>): void => {
    if (drag.current?.pointer !== event.pointerId) return
    event.stopPropagation()
    drag.current = null
    const capture = event.target as Element
    capture.releasePointerCapture(event.pointerId)
  }
  return (
    <>
      <color attach="background" args={[p.sky]} />
      <fog attach="fog" args={[p.sky, 260, 650]} />
      <hemisphereLight args={['#dce8ee', '#4c5140', 1.65]} />
      <directionalLight
        position={[-65, 95, 45]}
        intensity={2.7}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-125}
        shadow-camera-right={125}
        shadow-camera-top={125}
        shadow-camera-bottom={-125}
        shadow-camera-far={350}
        shadow-bias={-0.001}
      />
      <Ballpark textures={textures} />
      <PlayerShadows players={players} />
      {players.map(player => (
        <Player
          key={player.id}
          player={player}
          fabric={textures.cloth}
          selected={selected === player.id}
        />
      ))}
      <mesh
        name="interaction-surface"
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.26, -40]}
        onPointerDown={down}
        onPointerMove={event => {
          if (drag.current?.pointer === event.pointerId) {
            event.stopPropagation()
            move(event, drag.current.id)
          }
        }}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={() => {
          drag.current = null
        }}
      >
        <planeGeometry args={[1500, 1500]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </>
  )
}
