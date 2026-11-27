import { type PlacedIcon, zoneAt } from '../pressGrid'
import type { Rect } from './layout'

interface PendingRelease {
  center: boolean
  frame: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * Two contacts can share one iOS display frame. During that frame, a center
 * press can turn a crawl directly into a pause without asking both AVPlayers
 * to restart and then immediately stop their rendering pipelines.
 */
export class GridRelease {
  private pending: PendingRelease | null = null

  constructor(private readonly defer: (pending: boolean) => void) {}

  begin(): void {
    this.dispose()
    this.defer(true)
    const pending: PendingRelease = {
      center: false,
      frame: requestAnimationFrame(() => {
        if (!pending.center) this.finish(pending)
      }),
      // A center press may itself become a hold, or its release may be lost.
      // Each camera still receives its saved rate when this bound is reached.
      timer: setTimeout(() => {
        this.finish(pending)
      }, 100)
    }
    this.pending = pending
  }

  contact(x: number, y: number, block: Rect, shown: PlacedIcon[] | null): void {
    if (this.pending != null)
      this.pending.center = zoneAt(x, y, block, shown) === 'toggle'
  }

  /** The pause prop commits first. The next frame publishes its saved rate. */
  lifted(): void {
    const pending = this.pending
    if (pending == null) return
    cancelAnimationFrame(pending.frame)
    pending.frame = requestAnimationFrame(() => {
      this.finish(pending)
    })
  }

  finish(pending = this.pending): void {
    if (pending == null || pending !== this.pending) return
    this.dispose()
    this.defer(false)
  }

  dispose(): void {
    if (this.pending == null) return
    cancelAnimationFrame(this.pending.frame)
    clearTimeout(this.pending.timer)
    this.pending = null
  }
}
