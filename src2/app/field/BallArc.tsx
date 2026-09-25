/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import { useFrame } from '@react-three/fiber'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Color,
  Curve,
  type Group,
  Mesh,
  MeshBasicMaterial,
  Shape,
  TubeGeometry,
  Vector3
} from 'three'

import {
  arcPoint,
  type BallArcState,
  firstBounceFraction
} from './ballArcModel'
import { DESTINATION_RADIUS, DestinationMarker } from './DestinationMarker'
import { ARROW_OVERLAY_ORDER, arrowPulse } from './interactionAffordances'
import { TERRAIN } from './terrain'
import { trajectoryGrip } from './trajectoryGrip'
import { guideBearing, GuideBearingEase } from './trajectoryGuide'

class FlightCurve extends Curve<Vector3> {
  constructor(
    private readonly arc: BallArcState,
    private readonly from = 0,
    private readonly to = 1
  ) {
    super()
  }

  getPoint(t: number, target = new Vector3()): Vector3 {
    const point = arcPoint(this.arc, this.from + t * (this.to - this.from))
    return target.set(point.x, point.y, point.z)
  }
}
export function BallArc({
  arc: sourceArc,
  editing
}: {
  arc: BallArcState
  editing: boolean
}): React.ReactElement {
  const [ease] = useState(
    () => new GuideBearingEase(guideBearing(sourceArc.target))
  )
  const [bearing, setBearing] = useState(ease.value)
  const desired = guideBearing(sourceArc.target, ease.value)
  const targetBearing = useRef(desired)
  const startingFrame = useRef(false)
  if (desired !== targetBearing.current) {
    targetBearing.current = desired
    startingFrame.current = true
    ease.target(desired)
  }
  const arc = useMemo(
    () => ({ ...sourceArc, guideBearing: bearing }),
    [sourceArc, bearing]
  )
  const handle = useRef<Group>(null)
  const elapsed = useRef(0)
  const dark = useMemo(() => new Color('#4a3b00'), [])
  const yellow = useMemo(() => new Color('#ffe000'), [])
  const geometry = useMemo(
    () =>
      new TubeGeometry(
        new FlightCurve(
          arc,
          arc.angle < 0 ? firstBounceFraction(arc.angle) : 0
        ),
        160,
        0.23,
        5,
        false
      ),
    [arc]
  )
  useEffect(
    () => () => {
      geometry.dispose()
    },
    [geometry]
  )
  const direct = useMemo(
    () =>
      arc.angle < 0
        ? new TubeGeometry(
            new FlightCurve(arc, 0, firstBounceFraction(arc.angle)),
            1,
            0.23,
            5,
            false
          )
        : null,
    [arc]
  )
  useEffect(
    () => () => {
      direct?.dispose()
    },
    [direct]
  )
  const arrow = useMemo(() => {
    const shape = new Shape()
    shape.moveTo(-9, 0)
    shape.lineTo(0, 9)
    shape.lineTo(9, 0)
    shape.lineTo(5, 0)
    shape.lineTo(0, 5)
    shape.lineTo(-5, 0)
    shape.closePath()
    return shape
  }, [])
  useFrame(({ camera, size, invalidate }, dt) => {
    if (ease.settling) {
      // A demand renderer includes the idle interval in the first delta.
      // Begin the easing clock at this frame, rather than consuming that idle time.
      setBearing(ease.step(startingFrame.current ? 0 : Math.min(dt, 0.05)))
      startingFrame.current = false
      invalidate()
    }
    if (handle.current == null) return
    elapsed.current += Math.min(dt, 0.05)
    handle.current.quaternion.copy(camera.quaternion)
    const grip = trajectoryGrip(arc, camera, size)
    handle.current.position.copy(grip.position)
    handle.current.scale.setScalar(grip.scale)
    handle.current.children.forEach(child => {
      if (
        child.name === 'arc-pulse-arrow' &&
        child instanceof Mesh &&
        child.material instanceof MeshBasicMaterial
      ) {
        child.material.color
          .copy(dark)
          .lerp(
            yellow,
            arrowPulse((Math.abs(child.position.y) - 13) / 9, elapsed.current)
          )
      }
    })
    // Only the editing arrows keep the demand renderer alive. Done stops it.
    invalidate()
  })
  return (
    <group name="ball-arc" userData={{ bearing, settling: ease.settling }}>
      {direct != null && (
        <mesh geometry={direct} name="ball-direct-hit">
          <meshBasicMaterial color="#ffe044" toneMapped={false} />
        </mesh>
      )}
      <mesh geometry={geometry} name="ball-trajectory">
        <meshBasicMaterial color="#ffe044" toneMapped={false} />
      </mesh>
      <DestinationMarker
        position={[
          arc.target.x,
          (arc.landingHeight ?? TERRAIN.players) + 0.1,
          arc.target.z
        ]}
        radius={DESTINATION_RADIUS * (editing ? 0.5 : 1)}
        color={editing ? '#ffffff' : '#ffe000'}
      />
      {editing && (
        <group
          ref={handle}
          name="arc-angle-handle"
          renderOrder={ARROW_OVERLAY_ORDER}
        >
          {[3, 5, 7].map((radius, index) => (
            <mesh
              key={radius}
              name="arc-grab-ring"
              renderOrder={ARROW_OVERLAY_ORDER}
            >
              <ringGeometry args={[radius - 0.8, radius, 32]} />
              <meshBasicMaterial
                color="#ffe000"
                transparent
                opacity={1 - index * 0.2}
                depthTest={false}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          ))}
          {[-1, 1].flatMap(side =>
            [0, 1, 2].map(stop => (
              <mesh
                key={`${side}-${stop}`}
                name="arc-pulse-arrow"
                position={[0, side * (13 + stop * 9), 0]}
                rotation={[0, 0, side === -1 ? Math.PI : 0]}
                renderOrder={ARROW_OVERLAY_ORDER}
              >
                <shapeGeometry args={[arrow]} />
                <meshBasicMaterial
                  color="#ffe000"
                  transparent
                  opacity={1}
                  depthTest={false}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
            ))
          )}
        </group>
      )}
    </group>
  )
}
