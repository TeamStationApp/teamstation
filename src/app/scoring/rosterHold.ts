import type { RosterPoint } from './rosterGesture'

/** Display px an immediate contact must travel before it becomes a drag. */
export const ROSTER_DRAG_DISTANCE = 10

/** How long a contact holds still on a card before it picks the card up. */
export const ROSTER_HOLD_MS = 500

/**
 * A contact that starts scrolling can never turn into a drag midway through.
 * In immediate mode there is no hold: a contact that travels
 * ROSTER_DRAG_DISTANCE starts the drag at once, and a shorter one is a tap.
 * A contact that starts on a card's grip picks the card up as it lands; one
 * that ends there within ROSTER_HOLD_MS, short of ROSTER_DRAG_DISTANCE, is
 * still a tap, as a tap on that spot was before the card had a grip. Held
 * longer and let go in place, it calls the drag off, as a body hold does.
 */
export class RosterHold {
  active = false
  private origin: RosterPoint | null = null
  /** How far a contact begun on the grip has gone, or null for none. */
  private gripTravel: number | null = null
  /** When that contact began, in `Date.now()` milliseconds. */
  private gripStart = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    private readonly activate: (point: RosterPoint) => void,
    private readonly immediate: () => boolean = () => false
  ) {}

  start(point: RosterPoint, grip = false): void {
    this.cancel()
    this.origin = point
    if (grip) {
      this.gripTravel = 0
      this.gripStart = Date.now()
      this.active = true
      this.activate(point)
      return
    }
    if (this.immediate()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.origin == null) return
      this.active = true
      this.activate(this.origin)
    }, ROSTER_HOLD_MS)
  }

  move(point: RosterPoint): void {
    if (this.origin == null) return
    const distance = Math.hypot(
      point.x - this.origin.x,
      point.y - this.origin.y
    )
    if (this.gripTravel != null)
      this.gripTravel = Math.max(this.gripTravel, distance)
    if (this.active) return
    if (this.timer == null && this.immediate()) {
      if (distance < ROSTER_DRAG_DISTANCE) return
      this.active = true
      this.activate(this.origin)
    } else if (distance > 6) this.cancel()
  }

  /**
   * True only for a short stationary contact, never a hold or scroll: on the
   * body, one that never activated; on the grip, one that ended within
   * ROSTER_HOLD_MS and ROSTER_DRAG_DISTANCE, whose drag the caller then
   * cancels for the tap.
   */
  finish(): boolean {
    const tap =
      this.origin != null &&
      (!this.active ||
        (this.gripTravel != null &&
          this.gripTravel < ROSTER_DRAG_DISTANCE &&
          Date.now() - this.gripStart < ROSTER_HOLD_MS))
    this.cancel()
    return tap
  }

  cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.origin = null
    this.gripTravel = null
    this.active = false
  }
}
