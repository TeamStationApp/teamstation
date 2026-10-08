import { ROSTER_CARD_GAP } from './rosterLayout'

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
  drop: (id: number, edge?: 'before' | 'after') => void
  insertion?: 'row' | 'end'
  clip?: () => Promise<RosterRect>
}
export interface RosterScroll {
  measure: () => Promise<RosterRect>
  scroll: (delta: number) => void
  offset?: () => number
}
export interface RosterPreview extends RosterPoint {
  label: string
  source?: string
  cardRect?: RosterRect
  grab?: RosterPoint
  target?: string
  edge?: 'before' | 'after'
}
export const containsRosterPoint = (r: RosterRect, p: RosterPoint): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height

/** Both platform adapters measure in window coordinates; tokens discard stale measures/releases. */
export class RosterGesture {
  readonly listeners = new Set<(preview: RosterPreview | null) => void>()
  readonly sources = new Map<
    string,
    {
      measure: () => Promise<RosterRect>
      clip?: () => Promise<RosterRect>
      content: unknown
    }
  >()

  private geometry: Map<
    string,
    { rect: RosterRect; clip?: () => Promise<RosterRect>; offset: number }
  > | null = null

  private geometryReady: Promise<void> = Promise.resolve()
  readonly heldListeners = new Set<(held: boolean) => void>()
  targets = new Map<string, RosterTarget>()
  scrolls = new Map<string, RosterScroll>()
  active: {
    id: number
    label: string
    start: RosterPoint
    point: RosterPoint
    moved: boolean
    source?: string
    rect?: RosterRect
    grab?: RosterPoint
  } | null = null

  preview: RosterPreview | null = null
  private publish(value: RosterPreview | null): void {
    this.preview = value
    this.notify(value)
    for (const listener of this.listeners) listener(value)
  }

  private revision = 0
  private moveRevision = 0
  constructor(
    private readonly notify: (preview: RosterPreview | null) => void
  ) {}

  private setHeld(held: boolean): void {
    for (const listener of this.heldListeners) listener(held)
  }

  begin(id: number, label: string, point: RosterPoint, source?: string): void {
    this.cancel()
    const drag: NonNullable<RosterGesture['active']> = {
      id,
      label,
      start: point,
      point,
      moved: false,
      source
    }
    this.active = drag
    this.geometry = null
    const sourceCard = source == null ? undefined : this.sources.get(source)
    this.geometryReady =
      sourceCard == null
        ? Promise.resolve()
        : (async () => {
            const [rect, targets] = await Promise.all([
              sourceCard.measure(),
              Promise.all(
                [...this.targets].map(
                  async ([key, target]) =>
                    [
                      key,
                      {
                        rect: await target.measure(),
                        clip: target.clip,
                        offset: this.scrollOffset(target.clip)
                      }
                    ] as const
                )
              )
            ])
            if (this.active !== drag) return
            drag.rect = rect
            drag.grab = { x: point.x - rect.x, y: point.y - rect.y }
            this.geometry = new Map(targets)
            this.publish(this.dragPreview(drag.point))
          })().catch(() => {
            if (this.active === drag) this.cancel()
          })
    this.setHeld(true)
  }

  cancel(): void {
    this.revision++
    this.active = null
    this.geometry = null
    this.setHeld(false)
    this.publish(null)
  }

  private scrollOffset(clip?: () => Promise<RosterRect>): number {
    return (
      [...this.scrolls.values()]
        .find(scroll => scroll.measure === clip)
        ?.offset?.() ?? 0
    )
  }

  private dragPreview(point: RosterPoint): RosterPreview {
    const drag = this.active!
    return {
      ...point,
      label: drag.label,
      source: drag.source,
      cardRect: drag.rect,
      grab: drag.grab
    }
  }

  private async targetAt(
    point: RosterPoint
  ): Promise<{ key: string; edge?: 'before' | 'after' } | undefined> {
    const candidates = await Promise.all(
      [...this.targets].map(async ([key, target]) => {
        const frozen = this.geometry?.get(key)
        const rect =
          frozen == null
            ? await target.measure()
            : {
                ...frozen.rect,
                y:
                  frozen.rect.y -
                  (this.scrollOffset(frozen.clip) - frozen.offset)
              }
        const drag = this.active
        const source =
          drag?.source == null ? undefined : this.sources.get(drag.source)
        if (
          frozen != null &&
          drag?.rect != null &&
          source?.clip === target.clip &&
          frozen.rect.y > drag.rect.y
        )
          rect.y -= drag.rect.height + ROSTER_CARD_GAP
        if (
          frozen != null &&
          drag?.rect != null &&
          source?.clip === target.clip &&
          frozen.rect.y === drag.rect.y &&
          frozen.rect.x === drag.rect.x &&
          target.insertion === 'row'
        )
          return undefined
        // Every card takes half the gap above it and half the gap below it,
        // so a release between two lineup cards or two defensive positions
        // is never lost. Anywhere below the end target, down to the bottom of
        // its list, is the end of the list: hovering it opens a gap above it,
        // so an auto-scroll at the bottom edge can carry it up past a finger
        // resting below its label. Without a list to bound it, the end target
        // is just itself.
        const zone = {
          ...rect,
          y: rect.y - ROSTER_CARD_GAP / 2,
          height:
            target.insertion === 'end' && target.clip != null
              ? Number.POSITIVE_INFINITY
              : rect.height + ROSTER_CARD_GAP
        }
        const clip = target.clip == null ? zone : await target.clip()
        return containsRosterPoint(zone, point) &&
          containsRosterPoint(clip, point)
          ? {
              key,
              area: rect.width * rect.height,
              insideCard: containsRosterPoint(rect, point),
              edge:
                target.insertion == null
                  ? undefined
                  : target.insertion === 'end' ||
                      point.y < rect.y + rect.height / 2
                    ? ('before' as const)
                    : ('after' as const)
            }
          : undefined
      })
    )
    // A visible card wins over a neighbor's gap padding on compact fields.
    const hit = candidates
      .filter((c): c is NonNullable<typeof c> => c != null)
      .sort((a, b) =>
        a.insideCard === b.insideCard ? a.area - b.area : a.insideCard ? -1 : 1
      )[0]
    return hit
  }

  async move(point: RosterPoint): Promise<void> {
    const drag = this.active
    if (drag == null) return
    await this.geometryReady
    if (this.active !== drag) return
    drag.point = point
    drag.moved ||=
      Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 6
    if (!drag.moved) return
    const revision = this.revision
    const move = ++this.moveRevision
    this.publish({
      ...this.dragPreview(point),
      target: this.preview?.target,
      edge: this.preview?.edge
    })
    const target = await this.targetAt(point)
    if (revision === this.revision && move === this.moveRevision)
      this.publish({
        ...this.dragPreview(point),
        target: target?.key,
        edge: target?.edge
      })
  }

  async release(point: RosterPoint): Promise<boolean> {
    const drag = this.active
    if (drag == null) return false
    const revision = this.revision
    await this.geometryReady
    const target = drag.moved ? await this.targetAt(point) : undefined
    if (revision !== this.revision) return true
    this.cancel()
    if (target != null) this.targets.get(target.key)?.drop(drag.id, target.edge)
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
      const band = Math.min(36, rect.height / 4)
      const delta =
        drag.point.y < rect.y + band
          ? -18
          : drag.point.y > rect.y + rect.height - band
            ? 18
            : 0
      if (delta !== 0) scroll.scroll(delta)
    }
    if (revision === this.revision) await this.move(drag.point)
  }
}
