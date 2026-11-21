import { wallAt, type WallTimeline } from '../../common/wallTimeline'
import { commonStart, HOLE_MS, targetTime } from './playbackTimeline'

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
      target: null
    }
  }

  load(index: number, duration: number): void {
    const port = this.ports[index]
    port.loaded = true
    port.duration = duration > 0 ? duration : Infinity
    if (this.wall !== null) this.seekPort(port, this.wall)
    if (!this.playable(this.master) && this.available(index))
      this.master = index
  }

  start(wall = commonStart(this.ports.map(p => p.timeline))): void {
    if (wall !== null) this.seek(wall)
  }

  seek(wall: number): void {
    this.wall = this.pastSharedHole(wall)
    for (const port of this.ports) this.seekPort(port, this.wall)
    if (!this.playable(this.master)) {
      const next = this.ports.findIndex((_, i) => this.playable(i))
      if (next >= 0) this.master = next
    }
  }

  /** Full recording duration, without the seek guard before the final frame. */
  recordingExtent(): { start: number; end: number } | null {
    const ports = this.ports.filter(p => p.loaded && !p.failed)
    if (ports.length === 0 || ports.some(p => !Number.isFinite(p.duration)))
      return null
    const ranges = ports.map(p => ({
      start: wallAt(p.timeline.anchors, 0),
      end: wallAt(p.timeline.anchors, p.duration * 1000)
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
    const ranges = this.ports
      .filter(p => p.loaded && !p.failed)
      .flatMap(p => {
        const start = wallAt(p.timeline.anchors, 0)
        const end = Number.isFinite(p.duration)
          ? wallAt(p.timeline.anchors, p.duration * 1000)
          : Infinity
        return start === null || end === null ? [] : [{ start, end }]
      })
    if (ranges.length === 0) return null
    const next = Math.max(
      Math.min(...ranges.map(r => r.start)),
      Math.min(
        Math.max(...ranges.map(r => r.end)) - 100,
        this.wall + seconds * 1000
      )
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
    port.ended = !target.available
    port.position = target.seconds
    port.settling = true
    port.target = target.seconds
    port.seek(target.seconds)
  }

  settled(index: number): void {
    if (this.ports[index] !== undefined) this.ports[index].settling = false
  }

  progress(index: number, seconds: number): number | null {
    const port = this.ports[index]
    if (port === undefined || port.settling || port.failed || port.ended)
      return this.wall
    // Native progress queued before a seek can arrive after its completion callback.
    if (port.target !== null && Math.abs(seconds - port.target) > 1)
      return this.wall
    port.target = null
    const previous = port.position
    port.position = seconds
    if (index === this.master) {
      const wall = wallAt(port.timeline.anchors, seconds * 1000)
      // The master crossing a hole in its own recording must not drag every
      // other camera forward over it: the game goes on at 1× from a camera
      // that has this moment, and the master waits at its hole's far side.
      const expected =
        this.wall === null ? null : this.wall + (seconds - previous) * 1000
      if (wall !== null && expected !== null && wall - expected > HOLE_MS) {
        const next = this.ports.findIndex(
          p =>
            p !== port &&
            p.loaded &&
            !p.failed &&
            !p.ended &&
            targetTime(p.timeline, expected, p.duration)?.available === true
        )
        if (next >= 0) {
          this.master = next
          this.wall = expected
          this.seekPort(port, expected)
          return this.wall
        }
      }
      this.wall = wall
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
    if (this.playable(this.master)) return false
    const next = this.ports.findIndex((_, i) => this.playable(i))
    if (next >= 0) {
      this.master = next
      return false
    }
    // A pending native load may still supply the clock; load will select it.
    return this.ports.every(p => p.loaded || p.failed)
  }

  /** A failed camera opened again: it rejoins at the wall once it loads. */
  retry(index: number): void {
    const port = this.ports[index]
    if (port === undefined) return
    port.loaded = false
    port.failed = false
    port.ended = false
    port.settling = false
    port.target = null
  }

  /**
   * A moment no camera has a picture of, inside an outage they all shared,
   * goes on from the earliest picture after it: sought into it, every camera
   * was unavailable there, so ended, and the clock stood still.
   */
  private pastSharedHole(wall: number): number {
    let earliest: number | null = null
    for (const port of this.ports) {
      if (!port.loaded || port.failed) continue
      const target = targetTime(port.timeline, wall, port.duration)
      if (target === null) continue
      if (target.available) return wall
      // Not before its start or past its end: inside a hole in its recording.
      if (target.seconds <= 0 || target.seconds >= port.duration) continue
      const shown = wallAt(port.timeline.anchors, target.seconds * 1000)
      if (shown !== null && (earliest === null || shown < earliest))
        earliest = shown
    }
    return earliest ?? wall
  }

  /**
   * Available and loaded: only such a camera can carry the clock, since only
   * its progress moves the wall. One reopened (`retry`) is not, until it loads.
   */
  private playable(index: number): boolean {
    return this.ports[index]?.loaded && this.available(index)
  }

  available(index: number): boolean {
    const port = this.ports[index]
    if (port === undefined || port.failed || port.ended) return false
    return (
      this.wall === null ||
      targetTime(port.timeline, this.wall, port.duration)?.available !== false
    )
  }
}
