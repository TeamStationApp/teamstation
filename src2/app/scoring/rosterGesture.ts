export interface RosterPoint {
  x: number
  y: number
}
export interface RosterRect extends RosterPoint {
  width: number
  height: number
}
export interface RosterTarget {
  measure: () => Promise<RosterRect>
  drop: (id: number) => void
  clip?: () => Promise<RosterRect>
}
export interface RosterScroll {
  measure: () => Promise<RosterRect>
  scroll: (delta: number) => void
}
export interface RosterPreview extends RosterPoint {
  label: string
  target?: string
}
export const containsRosterPoint = (r: RosterRect, p: RosterPoint): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height

/** Both platform adapters measure in window coordinates; tokens discard stale measures/releases. */
export class RosterGesture {
  targets = new Map<string, RosterTarget>()
  scrolls = new Map<string, RosterScroll>()
  active: {
    id: number
    label: string
    start: RosterPoint
    point: RosterPoint
    moved: boolean
  } | null = null

  private revision = 0
  private moveRevision = 0
  constructor(
    private readonly notify: (preview: RosterPreview | null) => void
  ) {}

  begin(id: number, label: string, point: RosterPoint): void {
    this.cancel()
    this.active = { id, label, start: point, point, moved: false }
  }

  cancel(): void {
    this.revision++
    this.active = null
    this.notify(null)
  }

  private async targetAt(point: RosterPoint): Promise<string | undefined> {
    const candidates = await Promise.all(
      [...this.targets].map(async ([key, target]) => {
        const rect = await target.measure()
        const clip = target.clip == null ? rect : await target.clip()
        return containsRosterPoint(rect, point) &&
          containsRosterPoint(clip, point)
          ? { key, area: rect.width * rect.height }
          : undefined
      })
    )
    return candidates
      .filter((c): c is { key: string; area: number } => c != null)
      .sort((a, b) => a.area - b.area)[0]?.key
  }

  async move(point: RosterPoint): Promise<void> {
    const drag = this.active
    if (drag == null) return
    drag.point = point
    drag.moved ||=
      Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 6
    if (!drag.moved) return
    const revision = this.revision
    const move = ++this.moveRevision
    this.notify({ ...point, label: drag.label })
    const target = await this.targetAt(point)
    if (revision === this.revision && move === this.moveRevision)
      this.notify({ ...point, label: drag.label, target })
  }

  async release(point: RosterPoint): Promise<boolean> {
    const drag = this.active
    if (drag == null) return false
    const revision = this.revision
    const target = drag.moved ? await this.targetAt(point) : undefined
    if (revision !== this.revision) return true
    this.cancel()
    if (target != null) this.targets.get(target)?.drop(drag.id)
    return drag.moved
  }

  async tick(): Promise<void> {
    const drag = this.active
    if (drag?.moved !== true) return
    const revision = this.revision
    for (const scroll of this.scrolls.values()) {
      const rect = await scroll.measure()
      if (revision !== this.revision) return
      if (!containsRosterPoint(rect, drag.point)) continue
      const delta =
        drag.point.y < rect.y + 36
          ? -18
          : drag.point.y > rect.y + rect.height - 36
            ? 18
            : 0
      if (delta !== 0) scroll.scroll(delta)
    }
    if (revision === this.revision) await this.move(drag.point)
  }
}
