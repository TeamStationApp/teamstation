/* eslint-disable react/no-unknown-property -- React Three Fiber elements describe Three.js objects, not HTML. */
import { type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  type Mesh,
  type MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Plane,
  type Ray,
  Raycaster,
  Sprite,
  Vector3
} from 'three'

import { BallArc } from './BallArc'
import {
  arcHandle,
  arcTarget,
  type BallArcState,
  dragLaunchAngle
} from './ballArcModel'
import { Ballpark } from './Ballpark'
import { applyFieldCamera } from './cameraModel'
import type { FieldPlayer } from './fieldModel'
import { fieldPalette as p } from './fieldPalette'
import type { FieldCanvasProps } from './fieldTypes'
import {
  inArcGrabArea,
  placementRay,
  usesTouchPlacement
} from './interactionAffordances'
import { MoveGuide } from './MoveGuide'
import {
  beginMove,
  finishMove,
  type MoveDraft,
  previewMove
} from './movePreview'
import { Player } from './Player'
import { PlayerShadows } from './PlayerShadows'
import { useSurfaceTextures } from './surfaceTextures'
import { TERRAIN } from './terrain'

/** Scene is renderer-independent. Only the canvas adapter owns browser APIs. */
export function FieldScene(props: FieldCanvasProps): React.ReactElement {
  const {
    players,
    selected,
    onSelect,
    view,
    zoom,
    cameraTilt = 0,
    cameraHeight = 0,
    arc,
    arcMode = 'off',
    onArcChange,
    onArcFinish
  } = props
  const { camera, size, gl, invalidate, scene } = useThree()
  const { registerInterruption } = props
  const callbacks = useRef(props)
  callbacks.current = props
  const textures = useSurfaceTextures()
  const ready = useRef(false)
  useFrame(() => {
    if (!ready.current) {
      gl.domElement.setAttribute?.('data-field-ready', 'true')
      ready.current = true
    }
  })
  useEffect(() => {
    invalidate()
  }, [invalidate, props.movementRevision])
  useEffect(() => {
    gl.shadowMap.autoUpdate = false
    gl.shadowMap.needsUpdate = true
  }, [gl])
  const drag = useRef<MoveDraft | null>(null)
  const dragCapture = useRef<Element | null>(null)
  const gestureId = useRef(0)
  const dragGeneration = useRef(0)
  const [preview, setPreview] = useState<MoveDraft | null>(null)
  const picker = useMemo(() => new Raycaster(), [])
  const placementPicker = useMemo(() => new Raycaster(), [])
  const isTouch = (event: ThreeEvent<PointerEvent>): boolean =>
    usesTouchPlacement(
      event.pointerType ?? event.nativeEvent?.pointerType,
      props.touchPlacement === true
    )
  const destinationRay = (event: ThreeEvent<PointerEvent>): Ray =>
    placementRay(
      event.ray,
      event.pointer,
      camera,
      size.height,
      isTouch(event),
      placementPicker
    )
  const ground = useMemo(
    () => new Plane(new Vector3(0, 1, 0), -TERRAIN.players),
    []
  )
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

  const gesturePolicyKey = props.interaction?.gestures.join()
  const selectablePolicyKey = props.interaction?.selectableIds.join()
  useEffect(() => {
    setPreview(null)
    return () => {
      for (const player of players)
        if (player.keyboardOrigin != null) {
          player.target = { ...player.keyboardOrigin }
          delete player.keyboardOrigin
          callbacks.current.onGestureActive?.(false)
        }
      if (drag.current != null) {
        const player = players.find(item => item.id === drag.current?.id)
        if (player != null) finishMove(player, drag.current, true)
        drag.current = null
        callbacks.current.onGestureActive?.(false)
      }
    }
  }, [
    arcMode,
    view,
    players,
    props.interaction?.generation,
    gesturePolicyKey,
    selectablePolicyKey
  ])
  const move = (event: ThreeEvent<PointerEvent>): void => {
    if (
      drag.current?.pointer !== event.pointerId ||
      destinationRay(event).intersectPlane(ground, point) == null
    )
      return
    event.stopPropagation()
    previewMove(drag.current, point)
    setPreview({ ...drag.current })
    invalidate()
  }
  const eligible = players.filter(player =>
    props.interaction != null
      ? props.interaction.gestures.includes('place') &&
        props.interaction.selectableIds.includes(player.id)
      : props.selectableIds == null || props.selectableIds.includes(player.id)
  )
  const down = (event: ThreeEvent<PointerEvent>): void => {
    if (
      arcMode !== 'off' ||
      view === 'scoreboard' ||
      drag.current != null ||
      event.button !== 0
    )
      return
    event.stopPropagation()
    picker.ray.copy(event.ray)
    picker.camera = camera
    const roots = eligible
      .map(player => scene.getObjectByName(`player-${player.id}`))
      .filter((object): object is Object3D => object != null)
    scene.updateMatrixWorld(true)
    const hits = picker.intersectObjects(roots, true)
    const hit = hits.find(item => item.object instanceof Sprite) ?? hits[0]
    let object: Object3D | undefined = hit?.object
    while (
      object != null &&
      !eligible.some(player => object?.name === `player-${player.id}`)
    )
      object = object.parent ?? undefined
    let nearest: FieldPlayer | undefined = eligible.find(
      player => object?.name === `player-${player.id}`
    )
    // Also retain a small touch allowance when tapping beside a narrow limb.
    if (nearest == null) {
      let best = 20
      for (const player of eligible) {
        point.set(player.position.x, 5, player.position.z).project(camera)
        const distance = Math.hypot(
          ((point.x - event.pointer.x) * size.width) / 2,
          ((point.y - event.pointer.y) * size.height) / 2
        )
        if (distance < best) {
          nearest = player
          best = distance
        }
      }
    }
    const player = nearest ?? eligible.find(item => item.id === selected)
    if (player == null) return
    if (event.ray.intersectPlane(ground, point) == null) {
      if (nearest == null) return
      point.set(player.position.x, TERRAIN.players, player.position.z)
    }
    dragCapture.current = event.target as Element
    dragGeneration.current = props.interaction?.generation ?? 0
    gestureId.current++
    props.onGestureActive?.(true)
    onSelect(player.id)
    drag.current = beginMove(player, event.pointerId, point, nearest != null)
    if (isTouch(event)) {
      // Body/name picking uses the original ray. Only the destination is lifted.
      drag.current.offset = { x: 0, z: 0 }
      if (
        nearest == null &&
        destinationRay(event).intersectPlane(ground, point) != null
      )
        previewMove(drag.current, point)
    } else if (nearest == null) previewMove(drag.current, point)
    setPreview({ ...drag.current })
    const capture = event.target as Element
    capture.setPointerCapture(event.pointerId)
    invalidate()
  }
  const up = (event: ThreeEvent<PointerEvent>, cancel = false): void => {
    if (drag.current?.pointer !== event.pointerId) return
    event.stopPropagation()
    const player = players.find(item => item.id === drag.current?.id)
    if (player != null) {
      finishMove(player, drag.current, cancel)
      if (
        !cancel &&
        dragGeneration.current === (props.interaction?.generation ?? 0)
      ) {
        props.onPlayerPlacement?.(player.id, { ...player.target })
        props.onFieldPlacement?.({
          entityId: player.id,
          point: { ...player.target },
          generation: dragGeneration.current,
          gestureId: gestureId.current
        })
      }
    }
    drag.current = null
    props.onGestureActive?.(false)
    setPreview(null)
    const capture = event.target as Element
    capture.releasePointerCapture(event.pointerId)
    invalidate()
  }
  const lostMove = (): void => {
    if (drag.current != null) {
      const player = players.find(item => item.id === drag.current?.id)
      if (player != null) finishMove(player, drag.current, true)
      drag.current = null
      props.onGestureActive?.(false)
      setPreview(null)
      invalidate()
    }
  }
  const arcSurface = useRef<Mesh>(null)
  const arcDrag = useRef<{
    pointer: number
    kind: 'target' | 'angle'
    startY: number
    initial: BallArcState
    latest: BallArcState
    generation: number
    capture: Element
  } | null>(null)
  useEffect(() => {
    const cancel = (): void => {
      const moving = drag.current
      drag.current = null
      if (moving != null) {
        const player = callbacks.current.players.find(
          item => item.id === moving.id
        )
        if (player != null) finishMove(player, moving, true)
        dragCapture.current?.releasePointerCapture(moving.pointer)
        setPreview(null)
      }
      const active = arcDrag.current
      arcDrag.current = null
      if (active != null) {
        callbacks.current.onArcChange?.(active.initial)
        active.capture.releasePointerCapture(active.pointer)
      }
      callbacks.current.onGestureActive?.(false)
      invalidate()
    }
    registerInterruption?.(cancel)
    return () => {
      registerInterruption?.(null)
      cancel()
    }
  }, [registerInterruption, invalidate])
  const forward = useMemo(() => new Vector3(), [])
  // A camera-facing picking plane covers the arrows even when they lie above
  // the horizon. Ray/ground intersection is used only for landing placement.
  useFrame(() => {
    const surface = arcSurface.current
    if (surface == null || !(camera instanceof PerspectiveCamera)) return
    camera.getWorldDirection(forward)
    surface.position
      .copy(camera.position)
      .addScaledVector(forward, camera.near + 1)
    surface.quaternion.copy(camera.quaternion)
    const height =
      2 * Math.tan((camera.fov * Math.PI) / 360) * (camera.near + 1)
    surface.scale.set(height * camera.aspect, height, 1)
  })
  useEffect(
    () => () => {
      if (arcDrag.current != null) {
        callbacks.current.onArcChange?.(arcDrag.current.initial)
        arcDrag.current = null
        callbacks.current.onGestureActive?.(false)
      }
    },
    [arcMode, view, props.interaction?.generation]
  )
  const landingAt = (
    event: ThreeEvent<PointerEvent>
  ): Pick<BallArcState, 'target' | 'landingHeight'> | null => {
    const ray = destinationRay(event)
    const onGround = ray.intersectPlane(ground, point)
    const groundDistance =
      onGround == null ? Infinity : ray.origin.distanceTo(point)
    picker.ray.copy(ray)
    const stands = ['stadium-structure', 'stadium-seats']
      .map(name => scene.getObjectByName(name))
      .filter((object): object is Object3D => object != null)
    const hit = picker.intersectObjects(stands, false)[0]
    if (hit != null && hit.distance < groundDistance)
      return { target: arcTarget(hit.point), landingHeight: hit.point.y + 0.25 }
    return onGround == null ? null : { target: arcTarget(point) }
  }
  const aim = (
    event: ThreeEvent<PointerEvent>,
    initial: BallArcState
  ): void => {
    const landing = landingAt(event)
    if (landing == null) return
    const next = { ...landing, angle: initial.angle }
    if (arcDrag.current != null) arcDrag.current.latest = next
    onArcChange?.(next)
    invalidate()
  }
  const arcDown = (event: ThreeEvent<PointerEvent>): void => {
    event.stopPropagation()
    if (
      event.button !== 0 ||
      arcDrag.current != null ||
      (props.interaction != null &&
        !props.interaction.gestures.includes('trajectory'))
    )
      return
    if (arcMode === 'aim' && landingAt(event) == null) return
    const initial = arc ?? { target: { x: 0, z: -60 }, angle: 30 }
    if (arcMode === 'edit' && props.interaction == null) {
      const tip = arcHandle(initial)
      point.set(tip.x, tip.y, tip.z).project(camera)
      const dx = ((point.x - event.pointer.x) * size.width) / 2
      const dy = ((point.y - event.pointer.y) * size.height) / 2
      if (!inArcGrabArea(dx, dy)) return
    }
    arcDrag.current = {
      pointer: event.pointerId,
      kind: arcMode === 'aim' ? 'target' : 'angle',
      startY: (event.pointer.y * size.height) / 2,
      initial,
      latest: initial,
      generation: props.interaction?.generation ?? 0,
      capture: event.target as Element
    }
    props.onGestureActive?.(true)
    const capture = event.target as Element
    capture.setPointerCapture(event.pointerId)
    if (arcMode === 'aim') aim(event, initial)
  }
  const arcMove = (event: ThreeEvent<PointerEvent>): void => {
    const active = arcDrag.current
    if (active?.pointer !== event.pointerId) return
    event.stopPropagation()
    if (active.kind === 'target') aim(event, active.initial)
    else {
      const next = {
        ...active.initial,
        angle: dragLaunchAngle(
          active.initial.angle,
          (event.pointer.y * size.height) / 2 - active.startY
        )
      }
      active.latest = next
      onArcChange?.(next)
      invalidate()
    }
  }
  const arcUp = (event: ThreeEvent<PointerEvent>, cancel = false): void => {
    if (arcDrag.current?.pointer !== event.pointerId) return
    event.stopPropagation()
    const active = arcDrag.current
    arcDrag.current = null
    props.onGestureActive?.(false)
    const capture = event.target as Element
    capture.releasePointerCapture(event.pointerId)
    if (cancel) onArcChange?.(active.initial)
    else if (active.generation === (props.interaction?.generation ?? 0)) {
      onArcFinish?.()
      props.onTrajectoryAccepted?.(active.latest.angle, active.generation)
    }
  }
  return (
    <>
      <color attach="background" args={[p.sky]} />
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
      <Ballpark textures={textures} scoreboard={props.scoreboard} />
      <PlayerShadows players={players} />
      {props.hintBatSide != null && <BatterBoxHint side={props.hintBatSide} />}
      {arc != null && <BallArc arc={arc} editing={arcMode === 'edit'} />}
      {preview != null && <MoveGuide draft={preview} />}
      <mesh
        ref={arcSurface}
        name={
          arcMode === 'off' ? 'interaction-surface' : 'arc-interaction-surface'
        }
        onPointerDown={arcMode === 'off' ? down : arcDown}
        onPointerMove={arcMode === 'off' ? move : arcMove}
        onPointerUp={
          arcMode === 'off'
            ? event => {
                up(event)
              }
            : arcUp
        }
        onPointerCancel={
          arcMode === 'off'
            ? event => {
                up(event, true)
              }
            : event => {
                arcUp(event, true)
              }
        }
        onLostPointerCapture={() => {
          if (arcDrag.current != null) {
            onArcChange?.(arcDrag.current.initial)
            arcDrag.current = null
            props.onGestureActive?.(false)
          }
          lostMove()
        }}
      >
        <planeGeometry />
        <meshBasicMaterial visible={false} />
      </mesh>
      {players.map(player => (
        <Player
          key={player.id}
          player={player}
          fabric={textures.cloth}
          selected={
            selected === player.id &&
            eligible.some(item => item.id === player.id)
          }
        />
      ))}
    </>
  )
}

function BatterBoxHint({ side }: { side: 'L' | 'R' }): React.ReactElement {
  const material = useRef<MeshBasicMaterial>(null)
  const invalidate = useThree(state => state.invalidate)
  useFrame(({ clock }) => {
    if (material.current != null)
      material.current.opacity = 0.45 + Math.sin(clock.elapsedTime * 5) * 0.25
    invalidate()
  })
  return (
    <mesh
      name="switch-hitter-destination"
      position={[side === 'L' ? 4 : -4, TERRAIN.players + 0.1, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <ringGeometry args={[1.7, 2.3, 32]} />
      <meshBasicMaterial
        ref={material}
        color="#ffe38d"
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}
