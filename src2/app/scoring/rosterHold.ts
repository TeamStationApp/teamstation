import type { RosterPoint } from './rosterGesture'

/** A contact that starts scrolling can never turn into a drag midway through. */
export class RosterHold {
  active = false
  private origin: RosterPoint | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly activate: (point: RosterPoint) => void) {}
  start(point: RosterPoint): void {
    this.cancel()
    this.origin = point
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.origin == null) return
      this.active = true
      this.activate(this.origin)
    }, 500)
  }

  move(point: RosterPoint): void {
    if (this.active || this.origin == null) return
    if (Math.hypot(point.x - this.origin.x, point.y - this.origin.y) > 6)
      this.cancel()
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
