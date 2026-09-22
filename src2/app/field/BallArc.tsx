/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import { useFrame } from '@react-three/fiber'
import React, { useEffect, useMemo, useRef } from 'react'
import {
  Color,
  Curve,
  type Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Shape,
  TubeGeometry,
  Vector3
} from 'three'

import {
  arcHandle,
  arcPoint,
  type BallArcState,
  firstBounceFraction
} from './ballArcModel'
import { DestinationMarker } from './DestinationMarker'
import { ARROW_OVERLAY_ORDER, arrowPulse } from './interactionAffordances'
import { TERRAIN } from './terrain'

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
  arc,
  editing
}: {
  arc: BallArcState
  editing: boolean
}): React.ReactElement {
  const handle = useRef<Group>(null)
  const elapsed = useRef(0)
  const dark = useMemo(() => new Color('#4a3b00'), [])
  const yellow = useMemo(() => new Color('#ffe000'), [])
  const viewPoint = useMemo(() => new Vector3(), [])
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
  const tip = arcHandle(arc)
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
    if (handle.current == null) return
    elapsed.current += Math.min(dt, 0.05)
    handle.current.quaternion.copy(camera.quaternion)
    viewPoint
      .copy(handle.current.position)
      .applyMatrix4(camera.matrixWorldInverse)
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 43
    const pixel =
      (2 * Math.max(1, -viewPoint.z) * Math.tan((fov * Math.PI) / 360)) /
      Math.max(1, size.height)
    handle.current.scale.setScalar(pixel)
    handle.current.children.forEach((child, index) => {
      if (
        child instanceof Mesh &&
        child.material instanceof MeshBasicMaterial
      ) {
        child.material.color
          .copy(dark)
          .lerp(yellow, arrowPulse(index % 3, elapsed.current))
      }
    })
    // Only the editing arrows keep the demand renderer alive. Done stops it.
    invalidate()
  })
  return (
    <group name="ball-arc">
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
        radius={11}
      />
      {editing && (
        <group
          ref={handle}
          name="arc-angle-handle"
          renderOrder={ARROW_OVERLAY_ORDER}
          position={[tip.x, tip.y, tip.z]}
        >
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
