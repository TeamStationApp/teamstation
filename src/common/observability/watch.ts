import type { EventName, Property } from './contract'

// Hermes supplies this monotonic timer, but React Native's types omit it.
declare const performance: { now: () => number }

export interface WatchState {
  playing: boolean
  buffering: boolean
  foreground: boolean
  selected: boolean
  position: number
  rate: number
}

/** Monotonic active viewing time: position changes and playback rate never add watch time. */
export class WatchClock {
  private state: WatchState = {
    playing: false,
    buffering: false,
    foreground: true,
    selected: true,
    position: 0,
    rate: 1
  }

  private at: number
  private pending = 0
  private started = false
  private ended = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(
    private readonly video: string,
    private readonly session: string,
    private readonly emit: (
      event: EventName,
      properties: Record<string, Property>
    ) => void,
    private readonly now: () => number = () => performance.now()
  ) {
    this.at = now()
    this.timer = setInterval(() => {
      this.flush()
    }, 15000)
  }

  private eligible(): boolean {
    return (
      this.state.playing &&
      !this.state.buffering &&
      this.state.foreground &&
      this.state.selected
    )
  }

  private account(): void {
    const at = this.now()
    if (this.eligible()) this.pending += Math.max(0, at - this.at)
    this.at = at
  }

  private event(name: EventName, extra: Record<string, Property> = {}): void {
    try {
      this.emit(name, {
        vi: this.video,
        ps: this.session,
        pos: this.state.position,
        rt: this.state.rate,
        ...extra
      })
    } catch {}
  }

  update(patch: Partial<WatchState>): void {
    if (this.ended) return
    const before = this.state
    this.account()
    this.state = { ...before, ...patch }
    // Hidden angle tiles and feed previews never emit viewing events.
    if (this.state.selected && this.state.foreground) {
      if (
        this.state.playing &&
        (!this.started || !before.playing || !before.selected)
      ) {
        this.event(this.started ? 'video_resumed' : 'video_started')
        this.started = true
      } else if (before.playing && !this.state.playing && this.started)
        this.event('video_paused')
      if (this.started && before.buffering !== this.state.buffering)
        this.event(
          this.state.buffering
            ? 'video_buffering_started'
            : 'video_buffering_ended'
        )
    }
    if (!this.eligible()) this.flush()
  }

  seek(position: number): void {
    if (this.ended) return
    this.account()
    this.state.position = position
    if (this.started && this.state.selected) this.event('video_seeked')
    this.flush()
  }

  flush(): void {
    if (this.ended) return
    this.account()
    while (this.pending > 0) {
      const ms = Math.min(15000, this.pending)
      this.event('watch_progress', { ms })
      this.pending -= ms
    }
  }

  close(completed = false): void {
    if (this.ended) return
    this.flush()
    if (this.started) this.event(completed ? 'video_completed' : 'video_left')
    this.ended = true
    clearInterval(this.timer)
  }
}
