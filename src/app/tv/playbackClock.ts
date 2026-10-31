import { wallAt, type WallTimeline } from '../../common/wallTimeline'
import { commonStart, targetTime } from './playbackTimeline'

interface ClockPort {
  seek: (seconds: number) => void
  duration: number
  position: number
  timeline: WallTimeline
  loaded: boolean
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
  }

  start(wall = commonStart(this.ports.map(p => p.timeline))): void {
    if (wall !== null) this.seek(wall)
  }

  seek(wall: number): void {
    this.wall = wall
    for (const port of this.ports) this.seekPort(port, wall)
  }

  private seekPort(port: ClockPort, wall: number): void {
    const target = targetTime(port.timeline, wall, port.duration)
    if (!port.loaded || port.failed || target === null) return
    port.position = target.seconds
    port.settling = true
    port.target = target.seconds
    port.seek(target.seconds)
  }

  settled(index: number): void {
    this.ports[index].settling = false
  }

  progress(index: number, seconds: number): number | null {
    const port = this.ports[index]
    if (port.settling || port.failed) return this.wall
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

  fail(index: number): void {
    this.ports[index].failed = true
    if (index === this.master) {
      const next = this.ports.findIndex(p => !p.failed)
      if (next >= 0) this.master = next
    }
  }

  available(index: number): boolean {
    const port = this.ports[index]
    if (port.failed) return false
    return (
      this.wall === null ||
      targetTime(port.timeline, this.wall, port.duration)?.available !== false
    )
  }
}
