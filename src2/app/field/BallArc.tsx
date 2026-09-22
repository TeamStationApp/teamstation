/* eslint-disable react/no-unknown-property -- Three.js scene elements. */
import { useFrame } from '@react-three/fiber'
import React, { useEffect, useMemo, useRef } from 'react'
import { Curve, type Group, Shape, TubeGeometry, Vector3 } from 'three'

import {
  arcHandle,
  arcPoint,
  type BallArcState,
  firstBounceFraction
} from './ballArcModel'
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
  useFrame(({ camera, size }) => {
    if (handle.current == null) return
    handle.current.quaternion.copy(camera.quaternion)
    const pixel =
      (camera.position.distanceTo(handle.current.position) * 0.79) /
      Math.max(1, size.height)
    handle.current.scale.setScalar(pixel)
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
      <mesh
        position={[
          arc.target.x,
          (arc.landingHeight ?? TERRAIN.players) + 0.1,
          arc.target.z
        ]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[1.7, 2.2, 32]} />
        <meshBasicMaterial color="#ffe044" toneMapped={false} />
      </mesh>
      {editing && (
        <group
          ref={handle}
          name="arc-angle-handle"
          position={[tip.x, tip.y, tip.z]}
        >
          {[-1, 1].map(side => (
            <mesh
              key={side}
              position={[0, side * 13, 0]}
              rotation={[0, 0, side === -1 ? Math.PI : 0]}
              renderOrder={10}
            >
              <shapeGeometry args={[arrow]} />
              <meshBasicMaterial
                color="#ffe044"
                depthTest={false}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          ))}
        </group>
      )}
    </group>
  )
}
