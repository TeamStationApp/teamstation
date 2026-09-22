/* eslint-disable react/no-unknown-property -- React Three Fiber elements describe Three.js objects, not HTML. */
import { type ThreeEvent, useThree } from '@react-three/fiber'
import React, { useEffect, useMemo, useRef } from 'react'
import { PerspectiveCamera, Plane, Vector3 } from 'three'

import { Ballpark } from './Ballpark'
import { type CameraView, type FieldPlayer, setDestination } from './fieldModel'
import { fieldPalette as p } from './fieldPalette'
import type { FieldCanvasProps } from './fieldTypes'
import { Player } from './Player'

/** Scene is renderer-independent. Only the canvas adapter owns browser APIs. */
export function FieldScene(props: FieldCanvasProps): React.ReactElement {
  const { players, selected, onSelect, view, zoom } = props
  const { camera, size } = useThree()
  const drag = useRef<{ id: string; pointer: number } | null>(null)
  const ground = useMemo(() => new Plane(new Vector3(0, 1, 0), -0.25), [])
  const point = useMemo(() => new Vector3(), [])
  useEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return
    const narrow = size.width < size.height
    const distance = (narrow ? 1.4 : 1) / zoom
    const poses: Record<CameraView, [number, number, number]> = {
      home: [0, 100, 114],
      overhead: [0, 185, -35],
      infield: [37, 54, 55]
    }
    const [x, y, z] = poses[view]
    const center = view === 'infield' ? -24 : -48
    camera.position.set(
      x * distance,
      y * distance,
      center + (z - center) * distance
    )
    camera.fov = 43
    camera.near = 0.1
    camera.far = 900
    camera.lookAt(0, 0, center)
    camera.updateProjectionMatrix()
  }, [camera, size.width, size.height, view, zoom])

  const move = (event: ThreeEvent<PointerEvent>, id: string): void => {
    const player = players.find(item => item.id === id)
    if (player == null || event.ray.intersectPlane(ground, point) == null)
      return
    setDestination(player, point)
  }
  const down = (event: ThreeEvent<PointerEvent>): void => {
    if (drag.current != null || event.button !== 0) return
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
      <hemisphereLight args={['#fff5de', '#64746b', 2.5]} />
      <directionalLight
        position={[-70, 130, 60]}
        intensity={2.4}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-125}
        shadow-camera-right={125}
        shadow-camera-top={125}
        shadow-camera-bottom={-125}
        shadow-camera-far={350}
        shadow-bias={-0.001}
      />
      <Ballpark />
      {players.map(player => (
        <Player
          key={player.id}
          player={player}
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
