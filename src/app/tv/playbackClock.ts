import { wallAt, type WallTimeline } from '../../common/wallTimeline'
import { commonStart, targetTime } from './playbackTimeline'

interface ClockPort {
  seek: (seconds: number) => void
  duration: number
  position: number
  timeline: WallTimeline
  loaded: boolean
  ended: boolean
  failed: boolean
  settling: boolean
  target: number | null
  seekableEnd: number | null
  seekableStart: number
}
/** Native ports stay registered until the entire player closes, including hidden angles. */
export class PlaybackClock {
  readonly ports: ClockPort[] = []
  wall: number | null = null
  master = 0
  register(
    index: number,
    timeline: WallTimeline,
    seek: (seconds: number) => void
  ): void {
    this.ports[index] = {
      timeline,
      seek,
      duration: Infinity,
      position: 0,
      loaded: false,
      ended: false,
      failed: false,
      settling: false,
      target: null,
      seekableEnd: null,
      seekableStart: 0
    }
  }

  load(index: number, duration: number): void {
    const port = this.ports[index]
    port.loaded = true
    if (duration > 0) {
      port.failed = false
      port.ended = false
      port.settling = false
      port.target = null
    }
    port.duration = duration > 0 ? duration : Infinity
    if (this.wall !== null) this.seekPort(port, this.wall)
    if (!this.available(this.master) && this.available(index))
      this.master = index
  }

  start(wall = commonStart(this.ports.map(p => p.timeline))): void {
    if (wall !== null) this.seek(wall)
  }

  seek(wall: number): void {
    this.wall = wall
    for (const port of this.ports) this.seekPort(port, wall)
    if (!this.available(this.master)) {
      const next = this.ports.findIndex((_, i) => this.available(i))
      if (next >= 0) this.master = next
    }
  }

  /** Full recording duration, without the seek guard before the final frame. */
  recordingExtent(): { start: number; end: number } | null {
    const ports = this.ports.filter(p => p.loaded && !p.failed)
    const endOf = (p: ClockPort): number =>
      Number.isFinite(p.duration) ? p.duration : (p.seekableEnd ?? NaN)
    if (ports.length === 0 || ports.some(p => !Number.isFinite(endOf(p))))
      return null
    const ranges = ports.map(p => ({
      start: wallAt(
        p.timeline.anchors,
        Number.isFinite(p.duration) ? 0 : p.seekableStart * 1000
      ),
      end: wallAt(p.timeline.anchors, endOf(p) * 1000)
    }))
    if (ranges.some(r => r.start === null || r.end === null)) return null
    const start = Math.min(...ranges.map(r => r.start!))
    const end = Math.max(...ranges.map(r => r.end!))
    return end > start ? { start, end } : null
  }

  /** Seek across the union, stopping before the final frame. */
  extent(): { start: number; end: number } | null {
    const range = this.recordingExtent()
    return range === null || range.end - range.start <= 100
      ? null
      : { start: range.start, end: range.end - 100 }
  }

  move(seconds: number): number | null {
    if (this.wall === null) return null
    const range = this.extent()
    if (range === null) return null
    const next = Math.max(
      range.start,
      Math.min(range.end, this.wall + seconds * 1000)
    )
    this.seek(next)
    return next
  }

  /** Returns true only when the timeline has no continuing camera. */
  end(index: number): boolean {
    const port = this.ports[index]
    port.ended = true
    port.position = port.duration
    if (index !== this.master) return false
    const end = Number.isFinite(port.duration)
      ? wallAt(port.timeline.anchors, port.duration * 1000)
      : null
    if (end !== null) this.wall = end
    const next = this.ports.findIndex(
      (p, i) => p.loaded && !p.ended && this.available(i)
    )
    if (next < 0) return true
    this.master = next
    if (this.wall !== null) this.seekPort(this.ports[next], this.wall)
    return false
  }

  private seekPort(port: ClockPort, wall: number): void {
    const target = targetTime(port.timeline, wall, port.duration)
    if (!port.loaded || port.failed || target === null) return
    if (!this.inSeekableRange(port, target.seconds)) return
    port.ended =
      Number.isFinite(port.duration) && target.seconds >= port.duration
    port.position = target.seconds
    port.settling = true
    port.target = target.seconds
    port.seek(target.seconds)
  }

  settled(index: number): void {
    if (this.ports[index] !== undefined) this.ports[index].settling = false
  }

  progress(
    index: number,
    seconds: number,
    seekableEnd?: number,
    seekableStart?: number
  ): number | null {
    const port = this.ports[index]
    if (
      port !== undefined &&
      seekableStart != null &&
      Number.isFinite(seekableStart) &&
      seekableStart >= 0
    )
      port.seekableStart = seekableStart
    if (
      port !== undefined &&
      seekableEnd != null &&
      Number.isFinite(seekableEnd) &&
      seekableEnd > 0
    )
      port.seekableEnd = seekableEnd
    if (port === undefined || port.settling || port.failed || port.ended)
      return this.wall
    if (!this.available(index)) return this.wall
    // Native progress queued before a seek can arrive after its completion callback.
    if (port.target !== null && Math.abs(seconds - port.target) > 1)
      return this.wall
    port.target = null
    port.position = seconds
    if (index === this.master) {
      this.wall = wallAt(port.timeline.anchors, seconds * 1000)
      if (this.wall !== null) {
        for (const other of this.ports) {
          if (other === port || other.settling) continue
          const target = targetTime(other.timeline, this.wall, other.duration)
          if (
            target !== null &&
            Math.abs(target.seconds - other.position) > 0.75
          )
            this.seekPort(other, this.wall)
        }
      }
    }
    return this.wall
  }

  /** A failed master must never hand the clock back to an exhausted camera. */
  fail(index: number): boolean {
    this.ports[index].failed = true
    if (this.available(this.master)) return false
    const next = this.ports.findIndex((p, i) => p.loaded && this.available(i))
    if (next >= 0) {
      this.master = next
      return false
    }
    // A pending native load may still supply the clock; load will select it.
    return this.ports.every(p => p.loaded || p.failed)
  }

  private inSeekableRange(port: ClockPort, seconds: number): boolean {
    return (
      Number.isFinite(port.duration) ||
      port.seekableEnd === null ||
      (seconds >= port.seekableStart && seconds < port.seekableEnd)
    )
  }

  available(index: number): boolean {
    const port = this.ports[index]
    if (port === undefined || port.failed || port.ended) return false
    if (this.wall === null) return true
    const target = targetTime(port.timeline, this.wall, port.duration)
    return (
      target === null ||
      (target.available && this.inSeekableRange(port, target.seconds))
    )
  }
}
