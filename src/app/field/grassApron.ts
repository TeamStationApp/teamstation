import { Shape } from 'three'

import { OUTFIELD_HALF_ANGLE } from './stadiumBoundary'

export const FOUL_GRASS_METRES = 30 * 0.3048
export const BACK_GRASS_METRES = 50 * 0.3048

/** One continuous footprint, beneath dirt and chalk, with room in foul territory. */
export function grassApron(): Shape {
  const shape = new Shape()
  for (let i = 0; i <= 64; i++) {
    const angle = -OUTFIELD_HALF_ANGLE + (i / 64) * 2 * OUTFIELD_HALF_ANGLE
    const x = Math.sin(angle) * 114
    const y = Math.cos(angle) * 114
    if (i === 0) shape.moveTo(x, y)
    else shape.lineTo(x, y)
  }
  // A 45-degree baseline needs sqrt(2) times its perpendicular clearance in X.
  const width = FOUL_GRASS_METRES * Math.SQRT2
  shape.lineTo(width, 0)
  shape.lineTo(width, -BACK_GRASS_METRES)
  shape.lineTo(-width, -BACK_GRASS_METRES)
  shape.lineTo(-width, 0)
  shape.closePath()
  return shape
}
