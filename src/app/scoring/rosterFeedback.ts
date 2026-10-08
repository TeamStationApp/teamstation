import type { RosterPreview } from './rosterGesture'
import { type Position, POSITIONS } from './scoringTypes'

export interface RosterFeedbackCallbacks {
  ready: () => void
  hover: () => void
  reset: () => void
}

/** Feedback observes a drag; it never owns, mutates, or interrupts it. */
export class RosterFeedback {
  private source?: string
  private start?: { x: number; y: number }
  private moved = false
  private target?: string

  constructor(private readonly callbacks: RosterFeedbackCallbacks) {}

  private call(callback: () => void): void {
    try {
      callback()
    } catch {
      // Animation or platform feedback is best effort, never a drag failure.
    }
  }

  reset(): void {
    this.source = undefined
    this.start = undefined
    this.moved = false
    this.target = undefined
    this.call(this.callbacks.reset)
  }

  update(preview: RosterPreview | null, registered: boolean): void {
    if (
      !registered ||
      preview?.source == null ||
      preview.cardRect == null ||
      !(preview.cardRect.width > 0 && preview.cardRect.height > 0)
    ) {
      this.reset()
      return
    }
    if (this.source !== preview.source) {
      this.reset()
      this.source = preview.source
      this.start = { x: preview.x, y: preview.y }
      this.call(this.callbacks.ready)
    }
    if (
      !this.moved &&
      this.start != null &&
      Math.hypot(preview.x - this.start.x, preview.y - this.start.y) > 6
    ) {
      this.moved = true
      this.call(this.callbacks.reset)
    }
    const target =
      preview.target?.startsWith('defense-') === true &&
      POSITIONS.includes(preview.target.slice(8) as Position)
        ? preview.target
        : undefined
    if (target !== this.target) {
      this.target = target
      if (target != null) this.call(this.callbacks.hover)
    }
  }
}
