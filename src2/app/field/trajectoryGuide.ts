import type { GroundPoint } from './fieldModel'

export const GUIDE_SETTLE_SECONDS = 0.18
export function initialHitTarget(hand: string): GroundPoint {
  const bearing = ((hand === 'L' ? 15 : -15) * Math.PI) / 180
  return { x: 60 * Math.sin(bearing), z: -60 * Math.cos(bearing) }
}
export function guideBearing(target: GroundPoint, previous = -5): number {
  const angle = (Math.atan2(target.x, Math.abs(target.z)) * 180) / Math.PI
  if (Math.abs(angle) >= 5) return angle
  return (
    (angle === 0
      ? previous === 0
        ? -1
        : Math.sign(previous)
      : Math.sign(angle)) * 5
  )
}
/** A retargetable, bounded-time ease. Center can be crossed but is never a resting state. */
export class GuideBearingEase {
  value: number
  private from: number
  private to: number
  private elapsed = GUIDE_SETTLE_SECONDS
  constructor(value: number) {
    this.value = this.from = this.to = value
  }

  target(value: number): void {
    if (value === this.to) return
    this.from = this.value
    this.to = value
    this.elapsed = 0
  }

  get settling(): boolean {
    return this.elapsed < GUIDE_SETTLE_SECONDS
  }

  step(seconds: number): number {
    this.elapsed = Math.min(
      GUIDE_SETTLE_SECONDS,
      this.elapsed + Math.max(0, seconds)
    )
    const t = this.elapsed / GUIDE_SETTLE_SECONDS
    this.value = this.from + (this.to - this.from) * t * t * (3 - 2 * t)
    return this.value
  }
}
/** Bow the guide's launch direction; neither endpoint nor elevation changes. */
export function guideOffset(
  target: GroundPoint,
  bearing: number,
  t: number
): number {
  return (
    (Math.abs(target.z) * Math.tan((bearing * Math.PI) / 180) - target.x) *
    t *
    (1 - t)
  )
}
