import type { RosterPoint } from './rosterGesture'

/** Display px an immediate contact must travel before it becomes a drag. */
export const ROSTER_DRAG_DISTANCE = 10

/**
 * A contact that starts scrolling can never turn into a drag midway through.
 * In immediate mode there is no hold: a contact that travels
 * ROSTER_DRAG_DISTANCE starts the drag at once, and a shorter one is a tap.
 */
export class RosterHold {
  active = false
  private origin: RosterPoint | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    private readonly activate: (point: RosterPoint) => void,
    private readonly immediate: () => boolean = () => false
  ) {}

  start(point: RosterPoint): void {
    this.cancel()
    this.origin = point
    if (this.immediate()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.origin == null) return
      this.active = true
      this.activate(this.origin)
    }, 500)
  }

  move(point: RosterPoint): void {
    if (this.active || this.origin == null) return
    const distance = Math.hypot(
      point.x - this.origin.x,
      point.y - this.origin.y
    )
    if (this.timer == null && this.immediate()) {
      if (distance < ROSTER_DRAG_DISTANCE) return
      this.active = true
      this.activate(this.origin)
    } else if (distance > 6) this.cancel()
  }

  /** True only for a short stationary contact, never a hold or scroll. */
  finish(): boolean {
    const tap = this.origin != null && !this.active
    this.cancel()
    return tap
  }

  cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.origin = null
    this.active = false
  }
}
