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
  Vector3
} from 'three'

import {
  type RunnerDragView,
  runnerDragView,
  runnerTargetAt
} from '../scoring/runnerDrag'
import { BallArc } from './BallArc'
import {
  arcTarget,
  type BallArcState,
  dragLaunchAngle,
  TAP_SLOP_PX
} from './ballArcModel'
import { Ballpark } from './Ballpark'
import { applyFieldCamera } from './cameraModel'
import { fieldKey } from './fieldKeyboard'
import type { FieldPlayer } from './fieldModel'
import { BASES, clampToField } from './fieldModel'
import { fieldPalette as p } from './fieldPalette'
import type { FieldCanvasProps } from './fieldTypes'
import { frameThrottle } from './frameThrottle'
import {
  inArcGrabArea,
  isPrimaryPress,
  offsetTouchTarget,
  usesTouchPlacement
} from './interactionAffordances'
import { MoveGuide } from './MoveGuide'
import {
  beginMove,
  finishMove,
  type MoveDraft,
  previewMove
} from './movePreview'
import { PlayAnimation } from './PlayAnimation'
import { Player } from './Player'
import {
  hasPlayerLabel,
  nameplateContains,
  projectPlayerLabel
} from './playerPresentation'
import { PlayerShadows } from './PlayerShadows'
import { relativeLandingPointer } from './relativeLanding'
import { scoreboardBounds } from './scoreboardBounds'
import { homeRunLanding } from './stadiumBoundary'
import { useSurfaceTextures } from './surfaceTextures'
import { TERRAIN } from './terrain'
import { trajectoryGrip } from './trajectoryGrip'
import { guideBearing } from './trajectoryGuide'

/** Scene is renderer-independent. Only the canvas adapter owns browser APIs. */
export function FieldScene(props: FieldCanvasProps): React.ReactElement {
  const {
    players,
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
  // The angle the finger sets, once a frame at most (see frameThrottle).
  const [arcFrames] = useState(() =>
    frameThrottle<BallArcState>(next => {
      callbacks.current.onArcChange?.(next)
    })
  )
  const textures = useSurfaceTextures()
  const ready = useRef(false)
  const boundsKey = useRef('')
  const baseKey = useRef('')
  useFrame(() => {
    const report = callbacks.current.onNameplates
    if (report != null && camera instanceof PerspectiveCamera)
      report(
        callbacks.current.players
          .filter(
            player => player.suppressed !== true && hasPlayerLabel(player)
          )
          .map(player =>
            projectPlayerLabel(player, camera, size.width, size.height)
          )
      )
    if (callbacks.current.onBaseProjection != null) {
      const value = {
        width: size.width,
        height: size.height,
        bases: BASES.map(point => {
          const v = new Vector3(point.x, 9, point.z).project(camera)
          return {
            x: ((v.x + 1) * size.width) / 2,
            y: ((1 - v.y) * size.height) / 2
          }
        })
      }
      const key = JSON.stringify(value)
      if (baseKey.current !== key) {
        baseKey.current = key
        callbacks.current.onBaseProjection(value)
      }
    }
    if (callbacks.current.onScoreboardBounds != null) {
      const bounds = scoreboardBounds(camera, size.width, size.height)
      const key = JSON.stringify(bounds)
      if (boundsKey.current !== key) {
        boundsKey.current = key
        callbacks.current.onScoreboardBounds(bounds)
      }
    }
    if (!ready.current) {
      gl.domElement.setAttribute?.('data-field-ready', 'true')
      ready.current = true
    }
  })
  useEffect(() => {
    invalidate()
  }, [invalidate, props.movementRevision, props.presentationPaused])
  useEffect(() => {
    gl.shadowMap.autoUpdate = false
    gl.shadowMap.needsUpdate = true
  }, [gl])
  const drag = useRef<MoveDraft | null>(null)
  const dragCapture = useRef<Element | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runnerDrag = useRef<{
    id: string
    held: boolean
    moved: boolean
    view: RunnerDragView
    /** What the screen was last told of `view` (see `offered`). */
    shown?: string
  } | null>(null)
  /**
   * Tells the screen the runner's Safe/Out view when what it offers changed.
   * A finger reports faster than the screen draws, and each report re-renders
   * the drop targets; the runner and the guide follow it in the scene alone.
   */
  const offered = (runner: { view: RunnerDragView; shown?: string }): void => {
    const { view } = runner
    const shown = JSON.stringify([
      view.id,
      view.from,
      view.to,
      view.hovered,
      view.safeDisabled,
      view.keyboard,
      view.safe,
      view.out
    ])
    if (shown === runner.shown) return
    runner.shown = shown
    callbacks.current.onRunnerDrag?.({ ...view })
  }
  const clearHold = (): void => {
    if (holdTimer.current != null) clearTimeout(holdTimer.current)
    holdTimer.current = null
  }
  const screenAnchor = (position: {
    x: number
    z: number
  }): { x: number; y: number } => {
    const projected = new Vector3(position.x, 9, position.z).project(camera)
    return {
      x: ((projected.x + 1) * size.width) / 2,
      y: ((1 - projected.y) * size.height) / 2
    }
  }
  const { registerKeyboard } = props
  const gestureId = useRef(0)
  const dragGeneration = useRef(0)
  const [preview, setPreview] = useState<MoveDraft | null>(null)
  const picker = useMemo(() => new Raycaster(), [])
  const isTouch = (event: ThreeEvent<PointerEvent>): boolean =>
    usesTouchPlacement(
      event.pointerType ?? event.nativeEvent?.pointerType,
      props.touchPlacement === true
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
      heightOffset: cameraHeight,
      bottomExtension: props.bottomExtension
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
    props.bottomExtension,
    invalidate
  ])

  useEffect(() => {
    const handle = (key: string): boolean =>
      fieldKey(callbacks.current, key, {
        project: position => {
          const projected = new Vector3(position.x, 9, position.z).project(
            camera
          )
          return {
            x: ((projected.x + 1) * size.width) / 2,
            y: ((1 - projected.y) * size.height) / 2
          }
        },
        width: size.width,
        height: size.height
      })
    registerKeyboard?.(handle)
    return () => {
      registerKeyboard?.(null)
    }
  }, [
    registerKeyboard,
    camera,
    size.width,
    size.height,
    view,
    zoom,
    cameraTilt,
    cameraHeight
  ])

  const gesturePolicyKey = props.interaction?.gestures.join()
  const selectablePolicyKey = props.interaction?.selectableIds.join()
  useEffect(() => {
    setPreview(null)
    return () => {
      clearHold()
      if (runnerDrag.current != null) {
        runnerDrag.current = null
        callbacks.current.onRunnerCancel?.()
        callbacks.current.onRunnerDrag?.(null)
      }
      for (const player of players)
        if (player.keyboardOrigin != null) {
          player.target = { ...player.keyboardOrigin }
          delete player.keyboardOrigin
          callbacks.current.onRunnerDrag?.(null)
          callbacks.current.onSelect('')
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
    selectablePolicyKey,
    size.width,
    size.height
  ])
  const move = (event: ThreeEvent<PointerEvent>): void => {
    if (drag.current?.pointer !== event.pointerId) return
    event.stopPropagation()
    const runner = runnerDrag.current
    const pointer = {
      x: ((event.pointer.x + 1) * size.width) / 2,
      y: ((1 - event.pointer.y) * size.height) / 2
    }
    if (runner != null) {
      const hit = runnerTargetAt(runner.view, pointer)
      if (hit == null) {
        if (event.ray.intersectPlane(ground, point) == null) return
        runner.view = runnerDragView(
          runner.id,
          runner.view.from,
          point,
          screenAnchor,
          size.width,
          size.height,
          props.interaction?.retreatIds?.includes(runner.id) === true,
          props.interaction?.advanceIds == null ||
            props.interaction.advanceIds.includes(runner.id)
        )
      }
      runner.view.safeDisabled = props.runnerSafeError?.(
        runner.id,
        runner.view.to
      )
      // A retreat drop commits without the Safe/Out strip, but still honors
      // safeDisabled (occupied start base after the batter took it).
      // Retreat-only (no advanceIds) has no Safe/Out while resting on the offer.
      const canAdvance =
        props.interaction?.advanceIds == null ||
        props.interaction.advanceIds.includes(runner.id)
      runner.view.hovered =
        runner.view.to < runner.view.from
          ? runner.view.safeDisabled == null
            ? 'safe'
            : undefined
          : canAdvance
            ? runnerTargetAt(runner.view, pointer)
            : undefined
      drag.current.goal =
        runner.view.progress > 0.5 + 1e-12
          ? { ...BASES[runner.view.to % 4] }
          : { ...runner.view.point }
      drag.current.commit = false
      const player = players.find(item => item.id === runner.id)
      if (player != null) {
        player.position = { ...runner.view.point }
        player.target = { ...runner.view.point }
      }
      offered(runner)
    } else if (props.homeRunPlacement === true) {
      const landing = landingAt(event.ray, isTouch(event))
      if (landing == null) return
      drag.current.goal = homeRunLanding(landing.target)
      drag.current.landingHeight = landing.landingHeight
      drag.current.commit = true
      props.onLandingPreview?.(drag.current.goal)
    } else {
      if (event.ray.intersectPlane(ground, point) == null) return
      previewMove(drag.current, offsetTouchTarget(point, isTouch(event)))
      if (props.constrainPlacement != null)
        drag.current.goal = props.constrainPlacement(drag.current.goal)
    }
    if (runnerDrag.current != null) {
      if (
        Math.hypot(
          drag.current.goal.x - drag.current.origin.x,
          drag.current.goal.z - drag.current.origin.z
        ) > 2
      ) {
        runnerDrag.current.moved = true
        clearHold()
      }
    }
    // The guide reads the drag each frame it draws (MoveGuide's `live`), so
    // a move re-renders nothing. The frames themselves come from the loop
    // below, not from here.
  }
  // While a player is held the scene draws every frame, as it does while an
  // animation runs. On the Pixel 10 a frame asked for from each touch took
  // 17 ms to draw and the drag ran at 30 frames a second; from the loop it
  // takes 11 ms, and runs at 60.
  useFrame(() => {
    if (drag.current != null) invalidate()
  })
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
      !isPrimaryPress(event)
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
    let object: Object3D | undefined = hits[0]?.object
    while (
      object != null &&
      !eligible.some(player => object?.name === `player-${player.id}`)
    )
      object = object.parent ?? undefined
    let nearest: FieldPlayer | undefined = eligible.find(
      player => object?.name === `player-${player.id}`
    )
    if (nearest == null && camera instanceof PerspectiveCamera) {
      const pointerX = (event.pointer.x * 0.5 + 0.5) * size.width
      const pointerY = (0.5 - event.pointer.y * 0.5) * size.height
      nearest = eligible.find(player =>
        nameplateContains(
          player,
          camera,
          size.width,
          size.height,
          pointerX,
          pointerY
        )
      )
    }
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
    const player = nearest
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
    drag.current.touch = isTouch(event)
    if (props.interaction?.runnerIds?.includes(player.id) === true) {
      const from = player.runnerBase ?? (player.batting === true ? 0 : 1)
      drag.current.origin = { ...BASES[from % 4] }
      drag.current.next = { ...BASES[(from + 1) % 4] }
      const view = runnerDragView(
        player.id,
        from,
        drag.current.origin,
        screenAnchor,
        size.width,
        size.height,
        props.interaction?.retreatIds?.includes(player.id) === true,
        props.interaction?.advanceIds == null ||
          props.interaction.advanceIds.includes(player.id)
      )
      runnerDrag.current = { id: player.id, held: false, moved: false, view }
      clearHold()
      holdTimer.current = setTimeout(() => {
        if (runnerDrag.current?.id !== player.id) return
        runnerDrag.current.held = true
        offered(runnerDrag.current)
      }, 350)
    }
    if (isTouch(event)) {
      // Body/name picking uses the original ray. Only the destination is lifted.
      drag.current.offset = { x: 0, z: 0 }
      if (nearest == null && event.ray.intersectPlane(ground, point) != null)
        previewMove(drag.current, offsetTouchTarget(point, isTouch(event)))
      if (props.constrainPlacement != null)
        drag.current.goal = props.constrainPlacement(drag.current.goal)
    } else if (nearest == null)
      previewMove(drag.current, offsetTouchTarget(point, isTouch(event)))
    setPreview({ ...drag.current })
    const capture = event.target as Element
    capture.setPointerCapture(event.pointerId)
    invalidate()
  }
  const up = (event: ThreeEvent<PointerEvent>, cancel = false): void => {
    if (drag.current?.pointer !== event.pointerId) return
    event.stopPropagation()
    if (!cancel && runnerDrag.current != null) move(event)
    clearHold()
    const runner = runnerDrag.current
    runnerDrag.current = null
    const player = players.find(item => item.id === drag.current?.id)
    if (player != null) {
      finishMove(player, drag.current, cancel)
      const landing = props.constrainPlacement?.(player.target) ?? {
        ...player.target
      }
      if (props.homeRunPlacement === true)
        player.target = clampToField(player.target)
      if (
        !cancel &&
        dragGeneration.current === (props.interaction?.generation ?? 0)
      ) {
        if (runner != null) {
          player.position = { ...drag.current.origin }
          player.target = { ...drag.current.origin }
          if ((runner.moved || runner.held) && runner.view.hovered != null)
            props.onRunnerDrop?.(
              player.id,
              runner.view.to,
              runner.view.hovered,
              dragGeneration.current
            )
          else props.onRunnerCancel?.()
        } else if (
          (props.acceptDefenderTap === true && player.team === 'defense') ||
          Math.hypot(
            drag.current.goal.x - drag.current.origin.x,
            drag.current.goal.z - drag.current.origin.z
          ) > 0.5
        ) {
          props.onPlayerPlacement?.(player.id, { ...player.target })
          props.onFieldPlacement?.({
            entityId: player.id,
            point: landing,
            landingHeight: drag.current.landingHeight,
            generation: dragGeneration.current,
            gestureId: gestureId.current
          })
        }
      } else if (runner != null) props.onRunnerCancel?.()
    }
    if (player?.team === 'defense' && props.deferDefenderPlacement === true)
      finishMove(player, drag.current, true)
    drag.current = null
    props.onLandingPreview?.(null)
    props.onRunnerDrag?.(null)
    onSelect('')
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
      clearHold()
      runnerDrag.current = null
      props.onRunnerDrag?.(null)
      props.onRunnerCancel?.()
      props.onLandingPreview?.(null)
      onSelect('')
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
    startPointer: { x: number; y: number }
    moved: boolean
    /** The pointer went further up or down than a tap's slop. */
    turned: boolean
    initial: BallArcState
    latest: BallArcState
    generation: number
    capture: Element
  } | null>(null)
  useEffect(() => {
    const cancel = (): void => {
      clearHold()
      if (runnerDrag.current != null) {
        runnerDrag.current = null
        callbacks.current.onRunnerCancel?.()
      }
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
        arcFrames.cancel()
        callbacks.current.onArcChange?.(active.initial)
        active.capture.releasePointerCapture(active.pointer)
      }
      callbacks.current.onRunnerDrag?.(null)
      callbacks.current.onLandingPreview?.(null)
      callbacks.current.onSelect('')
      callbacks.current.onGestureActive?.(false)
      invalidate()
    }
    registerInterruption?.(cancel)
    return () => {
      registerInterruption?.(null)
      cancel()
    }
  }, [registerInterruption, invalidate, arcFrames])
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
    const topLeft = new Vector3(-1, 1, -1).unproject(camera)
    const bottomRight = new Vector3(1, -1, -1).unproject(camera)
    const factor = (camera.near + 1) / camera.near
    surface.position
      .copy(topLeft)
      .add(bottomRight)
      .multiplyScalar(0.5)
      .sub(camera.position)
      .multiplyScalar(factor)
      .add(camera.position)
    const localTop = camera.worldToLocal(topLeft.clone())
    const localBottom = camera.worldToLocal(bottomRight.clone())
    surface.scale.set(
      (localBottom.x - localTop.x) * factor,
      (localTop.y - localBottom.y) * factor,
      1
    )
  })
  useEffect(
    () => () => {
      if (arcDrag.current != null) {
        arcFrames.cancel()
        callbacks.current.onArcChange?.(arcDrag.current.initial)
        arcDrag.current = null
        callbacks.current.onGestureActive?.(false)
      }
    },
    [arcMode, view, props.interaction?.generation, arcFrames]
  )
  const landingAt = (
    ray: Ray,
    touch = false
  ): Pick<BallArcState, 'target' | 'landingHeight'> | null => {
    const onGround = ray.intersectPlane(ground, point)
    const groundDistance =
      onGround == null ? Infinity : ray.origin.distanceTo(point)
    picker.ray.copy(ray)
    const stands = ['stadium-structure', 'stadium-seats']
      .map(name => scene.getObjectByName(name))
      .filter((object): object is Object3D => object != null)
    const hit = picker.intersectObjects(stands, false)[0]
    if (hit != null && hit.distance < groundDistance)
      return {
        target: arcTarget(offsetTouchTarget(hit.point, touch)),
        landingHeight: hit.point.y + 0.25
      }
    return onGround == null
      ? null
      : { target: arcTarget(offsetTouchTarget(point, touch)) }
  }
  const aim = (
    event: ThreeEvent<PointerEvent>,
    initial: BallArcState
  ): void => {
    const active = arcDrag.current
    const relative = props.homeRunPlacement === true && active != null
    if (relative) {
      picker.setFromCamera(
        relativeLandingPointer(
          initial,
          active.startPointer,
          event.pointer,
          camera
        ),
        camera
      )
    }
    const landing = landingAt(
      relative ? picker.ray : event.ray,
      !relative && isTouch(event)
    )
    if (landing == null) return
    const next = {
      ...landing,
      target:
        props.homeRunPlacement === true
          ? homeRunLanding(landing.target)
          : landing.target,
      angle: initial.angle
    }
    if (props.homeRunPlacement === true) props.onLandingPreview?.(next.target)
    if (arcDrag.current != null) arcDrag.current.latest = next
    onArcChange?.(next)
    invalidate()
  }
  const arcDown = (event: ThreeEvent<PointerEvent>): void => {
    event.stopPropagation()
    if (
      !isPrimaryPress(event) ||
      arcDrag.current != null ||
      (props.interaction != null &&
        !props.interaction.gestures.includes('trajectory'))
    )
      return
    if (
      arcMode === 'aim' &&
      props.homeRunPlacement !== true &&
      landingAt(event.ray, isTouch(event)) == null
    )
      return
    const initial = arc ?? { target: { x: 0, z: -60 }, angle: 30 }
    if (arcMode === 'edit' && props.interaction == null) {
      const grip = trajectoryGrip(
        { ...initial, guideBearing: guideBearing(initial.target) },
        camera,
        size
      )
      point.copy(grip.position).project(camera)
      const dx = ((point.x - event.pointer.x) * size.width) / 2
      const dy = ((point.y - event.pointer.y) * size.height) / 2
      if (!inArcGrabArea(dx, dy)) return
    }
    arcDrag.current = {
      pointer: event.pointerId,
      kind: arcMode === 'aim' ? 'target' : 'angle',
      startY: (event.pointer.y * size.height) / 2,
      startPointer: { x: event.pointer.x, y: event.pointer.y },
      moved: false,
      turned: false,
      initial,
      latest: initial,
      generation: props.interaction?.generation ?? 0,
      capture: event.target as Element
    }
    props.onGestureActive?.(true)
    const capture = event.target as Element
    capture.setPointerCapture(event.pointerId)
    if (arcMode === 'aim' && props.homeRunPlacement !== true)
      aim(event, initial)
  }
  const arcMove = (event: ThreeEvent<PointerEvent>): void => {
    const active = arcDrag.current
    if (active?.pointer !== event.pointerId) return
    event.stopPropagation()
    active.moved ||=
      Math.hypot(
        ((event.pointer.x - active.startPointer.x) * size.width) / 2,
        ((event.pointer.y - active.startPointer.y) * size.height) / 2
      ) > TAP_SLOP_PX
    if (active.kind === 'target') aim(event, active.initial)
    else {
      const pixelsUp = (event.pointer.y * size.height) / 2 - active.startY
      active.turned ||= Math.abs(pixelsUp) > TAP_SLOP_PX
      const next = {
        ...active.initial,
        angle: dragLaunchAngle(active.initial.angle, pixelsUp)
      }
      active.latest = next
      arcFrames(next)
      invalidate()
    }
  }
  const arcUp = (event: ThreeEvent<PointerEvent>, cancel = false): void => {
    if (arcDrag.current?.pointer !== event.pointerId) return
    event.stopPropagation()
    arcFrames.flush()
    const active = arcDrag.current
    arcDrag.current = null
    props.onGestureActive?.(false)
    const capture = event.target as Element
    capture.releasePointerCapture(event.pointerId)
    if (cancel || (props.homeRunPlacement === true && !active.moved))
      onArcChange?.(active.initial)
    else if (active.generation === (props.interaction?.generation ?? 0)) {
      if (active.kind === 'target') {
        onArcFinish?.()
        props.onLandingAccepted?.(active.latest, active.generation)
      } else {
        // Only a vertical drag turns the angle: a tap, a pointer that
        // slipped sideways or a finger's wobble within the slop accepts the
        // angle it started at.
        const accepted = active.turned ? active.latest : active.initial
        if (!active.turned) onArcChange?.(active.initial)
        onArcFinish?.()
        props.onTrajectoryAccepted?.(
          accepted.angle,
          active.generation,
          active.turned
        )
      }
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
      <Ballpark
        textures={textures}
        scoreboard={props.scoreboard}
        teams={props.teams}
      />
      <PlayerShadows players={players} />
      {props.presentation != null && (
        <PlayAnimation
          key={props.presentation.id}
          sequence={props.presentation}
          players={players}
          paused={props.presentationPaused === true}
          onContact={props.onPresentationContact}
          onComplete={(id, generation, stage) => {
            props.onPresentationDone?.(id, generation, stage)
          }}
        />
      )}

      {props.hintBatSide != null && <BatterBoxHint side={props.hintBatSide} />}
      {arc != null && (
        <BallArc
          key={props.interaction?.generation}
          arc={arc}
          editing={arcMode === 'edit'}
        />
      )}
      {preview != null && <MoveGuide draft={preview} live={drag} />}
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
            arcFrames.cancel()
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
          onMovementComplete={props.onMovementComplete}
          paused={props.presentationPaused}
          selected={
            (preview?.id === player.id || player.keyboardOrigin != null) &&
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
