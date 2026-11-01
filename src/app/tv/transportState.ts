export type RemoteDirection = 'left' | 'right' | 'up' | 'down'
export type RemoteInput =
  | { kind: 'click' | 'swipe'; direction: RemoteDirection }
  | { kind: 'hold'; direction: RemoteDirection; phase: 'begin' | 'end' }
  | { kind: 'pan'; phase: 'begin' | 'change' | 'end' | 'cancel'; x: number }
  | { kind: 'playPause' | 'cancel' }

export interface TransportSnapshot {
  visible: boolean
  rate: number
}
export interface TransportHost {
  move: (seconds: number) => void
  seek: (wall: number) => void
  position: () => number | null
  extent: () => { start: number; end: number } | null
  width: () => number
  panEnabled: (enabled: boolean) => void
  changed: (snapshot: TransportSnapshot) => void
  now: () => number
  later: (callback: () => void, ms: number) => unknown
  clear: (timer: unknown) => void
}

/** One owner for transport timers. Native players always share its target and rate. */
export class TvTransport {
  private visible = false
  private rate = 1
  private held: RemoteDirection | null = null
  private repeat: unknown
  private hide: unknown
  private flush: unknown
  private pending: number | null = null
  private pan: {
    wall: number
    width: number
    start: number
    end: number
  } | null = null

  private suppress: { direction: RemoteDirection; until: number } | null = null
  private touchUntil = 0

  constructor(private readonly host: TransportHost) {}

  private stop(timer: 'repeat' | 'hide' | 'flush'): void {
    if (this[timer] !== undefined) this.host.clear(this[timer])
    this[timer] = undefined
  }

  private publish(): void {
    this.host.changed({ visible: this.visible, rate: this.rate })
  }

  private show(): void {
    this.stop('hide')
    if (!this.visible) {
      this.visible = true
      this.host.panEnabled(true)
      this.publish()
    }
  }

  private dismissLater(): void {
    this.stop('hide')
    this.hide = this.host.later(() => {
      this.hide = undefined
      this.closeScrub()
    }, 2000)
  }

  private closeScrub(): void {
    this.stop('hide')
    this.stop('flush')
    this.pending = null
    this.pan = null
    if (this.visible) {
      this.visible = false
      this.host.panEnabled(false)
      this.publish()
    }
  }

  cancel(): void {
    this.stop('repeat')
    this.held = null
    this.suppress = null
    this.rate = 1
    this.closeScrub()
    this.publish()
  }

  private jump(direction: RemoteDirection): void {
    this.show()
    if (this.host.extent() !== null)
      this.host.move(direction === 'right' ? 10 : -10)
  }

  private repeatJump(direction: RemoteDirection): void {
    this.repeat = this.host.later(() => {
      this.repeat = undefined
      if (this.held !== direction) return
      this.jump(direction)
      this.repeatJump(direction)
    }, 1000 / 3)
  }

  /** True consumes the input; false leaves ordinary focus navigation to the player. */
  handle(input: RemoteInput): boolean {
    if (input.kind === 'cancel') {
      this.cancel()
      return true
    }
    if (input.kind === 'hold') {
      if (input.direction === 'down') return false
      if (input.phase === 'end') {
        if (this.held !== input.direction) return true
        this.stop('repeat')
        this.held = null
        this.suppress = {
          direction: input.direction,
          until: this.host.now() + 300
        }
        if (this.rate !== 1) {
          this.rate = 1
          this.publish()
        }
        if (this.visible) this.dismissLater()
      } else if (this.held !== input.direction) {
        this.cancel()
        this.held = input.direction
        if (input.direction === 'up') {
          this.rate = 0.25
          this.publish()
        } else {
          this.jump(input.direction)
          this.repeatJump(input.direction)
        }
      }
      return true
    }
    if (input.kind === 'click') {
      if (
        this.held !== null ||
        (this.suppress?.direction === input.direction &&
          this.host.now() <= this.suppress.until)
      )
        return true
      if (input.direction !== 'left' && input.direction !== 'right')
        return false
      this.jump(input.direction)
      this.dismissLater()
      return true
    }
    if (input.kind === 'pan') {
      // A pressed clickpad may also emit touch movement. The hold owns transport.
      if (this.held !== null) return true
      if (!this.visible) return false
      this.touchUntil = this.host.now() + 300
      if (input.phase === 'begin') {
        this.stop('hide')
        const extent = this.host.extent()
        const wall = this.host.position()
        const width = this.host.width()
        this.pan =
          extent !== null && wall !== null && width > 0
            ? { ...extent, wall, width }
            : null
      }
      if (this.pan !== null && input.phase !== 'cancel') {
        const { wall, width, start, end } = this.pan
        this.pending = Math.max(
          start,
          Math.min(end, wall + (input.x / width) * (end - start) * 0.3)
        )
        if (this.flush === undefined)
          this.flush = this.host.later(() => {
            this.flush = undefined
            if (this.pending !== null) this.host.seek(this.pending)
            this.pending = null
          }, 16)
      }
      if (input.phase === 'end' || input.phase === 'cancel') {
        if (input.phase === 'cancel') {
          this.stop('flush')
          this.pending = null
        }
        this.pan = null
        this.dismissLater()
      }
      return true
    }
    if (
      input.kind === 'swipe' &&
      (this.visible || this.host.now() < this.touchUntil)
    ) {
      // UIKit may emit a discrete swipe for the same touch as the pan.
      return true
    }
    return false
  }
}
