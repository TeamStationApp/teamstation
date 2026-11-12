import { inWallGap, wallAt, type WallTimeline } from '../../common/wallTimeline'
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
  pendingWall: number | null
  seekableEnd: number | null
  seekableStart: number
  /** The latest steps its live seekable edge advanced by, in seconds. */
  edgeSteps: number[]
}
/** The segment length assumed until a camera's edge has advanced a few times. */
const SEGMENT_SEC = 4
/** The longest a playlist's segments run (`EXT-X-TARGETDURATION`). */
const MAX_SEGMENT_SEC = 12
/** How many of a camera's latest edge steps its segment length is read from. */
const EDGE_STEPS = 5
/**
 * How many segments a current camera's safe edge may trail the newest one:
 * one of phase, one of a late playlist reload, and one of hold-back.
 */
const EDGE_SPREAD_SEGMENTS = 3

/**
 * A camera's segment length: the median of its latest edge steps, so one
 * reload listing several segments at once does not stretch it.
 */
function segmentOf(port: ClockPort): number {
  if (port.edgeSteps.length < 3) return SEGMENT_SEC
  const sorted = [...port.edgeSteps].sort((a, b) => a - b)
  return Math.max(SEGMENT_SEC, sorted[Math.floor(sorted.length / 2)])
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
      pendingWall: null,
      seekableEnd: null,
      seekableStart: 0,
      edgeSteps: []
    }
  }

  load(index: number, duration: number): void {
    const port = this.ports[index]
    port.loaded = true
    port.failed = false
    port.ended = false
    port.settling = false
    port.target = null
    port.pendingWall = null
    port.duration = duration > 0 ? duration : Infinity
    port.seekableEnd = null
    port.seekableStart = 0
    if (this.wall !== null) this.seekPort(port, this.wall, true)
    if (!this.available(this.master) && this.available(index))
      this.master = index
  }

  start(wall = commonStart(this.ports.map(p => p.timeline))): void {
    if (wall !== null) this.seek(wall)
  }

  seek(wall: number): void {
    this.wall = wall
    for (const port of this.ports) this.seekPort(port, wall, true)
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

  private seekPort(port: ClockPort, wall: number, requireBounds = false): void {
    const target = targetTime(port.timeline, wall, port.duration)
    if (!port.loaded || target === null) return
    // A failed seek beyond a short recording must not suppress recovery after
    // the viewer returns to footage that this camera actually has.
    port.ended =
      Number.isFinite(port.duration) && target.seconds >= port.duration
    if (port.failed) return
    if (
      ((requireBounds || port.pendingWall !== null) &&
        !Number.isFinite(port.duration) &&
        port.seekableEnd === null) ||
      !this.inSeekableRange(port, target.seconds)
    ) {
      if (requireBounds || port.pendingWall !== null) port.pendingWall = wall
      return
    }
    port.pendingWall = null
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
    seekableStart?: number,
    playing = true
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
    ) {
      // A feed keeps its segment length across reloads, so the steps stay.
      const step = seekableEnd - (port.seekableEnd ?? seekableEnd)
      if (step > 0 && step <= MAX_SEGMENT_SEC)
        port.edgeSteps = [...port.edgeSteps, step].slice(-EDGE_STEPS)
      port.seekableEnd = seekableEnd
    }
    if (port === undefined || port.failed || port.ended) return this.wall
    // A replacement live source may open at the live edge. Restore the selected
    // moment only once its new seekable bounds arrive, and ignore that first frame.
    if (port.pendingWall !== null) {
      const target = targetTime(port.timeline, port.pendingWall, port.duration)
      const decodedWall = wallAt(port.timeline.anchors, seconds * 1000)
      // AVPlayer can decode live frames beyond its safe seek edge. A recovering
      // playing camera already at the shared moment needs no impossible seek.
      // Paused selections and cameras at a different moment still wait/restore.
      if (
        playing &&
        !Number.isFinite(port.duration) &&
        port.seekableEnd !== null &&
        target?.available === true &&
        target.seconds >= port.seekableEnd &&
        decodedWall !== null &&
        Math.abs(decodedWall - port.pendingWall) <= 500
      ) {
        port.pendingWall = null
      } else {
        // Two live decoders can run at a fixed offset beyond their safe seek
        // edges. Chasing the moving master there can never converge. Rejoin
        // playing cameras in footage they can all seek, without accepting skew
        // or changing a paused selection (or crossing a known missing span).
        // A camera whose feed stopped, or has only just come back after a
        // gap, is not one of them: it stays covered until its footage reaches
        // the moment rather than pulling the others back to its last picture
        // (`rejoinSeekable` refuses both, and leaves covered cameras out).
        // A decoder ahead of the moment, in the same unbroken stretch of
        // footage, is as stuck as one behind it: the moment is past its safe
        // edge, so the seek that would restore it is never made, and both
        // play on at 1×. One ahead across a discontinuity is post-gap
        // footage, not this moment, and stays covered.
        if (
          playing &&
          !Number.isFinite(port.duration) &&
          port.seekableEnd !== null &&
          target?.available === true &&
          target.seconds >= port.seekableEnd &&
          decodedWall !== null &&
          (decodedWall < port.pendingWall - 500 ||
            (decodedWall > port.pendingWall + 500 &&
              Math.abs(
                decodedWall -
                  port.pendingWall -
                  (seconds - target.seconds) * 1000
              ) <= 1)) &&
          this.available(this.master) &&
          this.rejoinSeekable(port)
        )
          return this.wall
        this.seekPort(port, port.pendingWall, true)
        return this.wall
      }
    }
    if (port.settling) return this.wall
    // Native progress queued before a seek can arrive after its completion callback.
    if (port.target !== null && Math.abs(seconds - port.target) > 1)
      return this.wall
    port.target = null
    const advanced = seconds > port.position
    port.position = seconds
    if (!this.available(this.master) && this.available(index))
      this.master = index
    if (!this.available(index)) {
      // A healthy live camera playing on behind a master that moved past its
      // safe seek edge (a refreshed mapping, or the master held it while its
      // own feed restarted) can never be sought to the master's moment, and
      // at 1× never reaches it. Rejoin both in the newest footage they can
      // all seek. A camera that is not advancing (its feed stopped) does not
      // pull the others back; `rejoinSeekable` refuses one missing footage.
      if (
        playing &&
        advanced &&
        index !== this.master &&
        this.beyondSafeEdge(port) &&
        this.available(this.master) &&
        this.rejoinSeekable(port)
      )
        return this.wall
      // With no camera covering this gap, no other master can advance the wall.
      // Playing rejoins at a decoded post-gap moment; a paused selection stays
      // covered, and any camera that still covers it keeps ownership of the clock.
      const nextWall = wallAt(port.timeline.anchors, seconds * 1000)
      if (
        !playing ||
        this.wall === null ||
        !inWallGap(port.timeline.anchors, this.wall, port.timeline.source) ||
        this.ports.some((p, i) => p.loaded && this.available(i)) ||
        nextWall === null ||
        nextWall < this.wall ||
        inWallGap(port.timeline.anchors, nextWall, port.timeline.source)
      )
        return this.wall
      this.master = index
    }
    if (index === this.master) {
      this.wall = wallAt(port.timeline.anchors, seconds * 1000)
      if (this.wall !== null) {
        for (const other of this.ports) {
          if (other === port || other.settling) continue
          const target = targetTime(other.timeline, this.wall, other.duration)
          // A camera with no footage here only plays on under its cover;
          // its clamped target would pull it back every tick.
          if (
            target?.available === true &&
            Math.abs(target.seconds - other.position) > 0.75
          )
            this.seekPort(other, this.wall)
        }
      }
    }
    return this.wall
  }

  /**
   * Seeks the joining camera and the cameras on screen to footage they can
   * all seek. A camera already covered (its feed stopped) is left out.
   */
  private rejoinSeekable(joining: ClockPort): boolean {
    if (this.wall === null) return false
    const together = this.ports.filter(
      (p, i) =>
        p === joining ||
        (p.loaded && !p.failed && !p.ended && this.available(i))
    )
    const edges = new Map<ClockPort, number>()
    for (const port of together) {
      const end = Number.isFinite(port.duration)
        ? port.duration
        : port.seekableEnd
      if (end === null) return false
      const edge = wallAt(port.timeline.anchors, end * 1000)
      if (edge === null) return false
      edges.set(port, edge)
    }
    // A camera whose edge trails the newest by more than a current feed's
    // lag is missing footage: its feed stopped, or it has come back and its
    // timeline does not yet hold the return. It stays covered.
    const own = edges.get(joining)!
    const newest = Math.max(
      ...together.flatMap(p =>
        Number.isFinite(p.duration) ? [] : [edges.get(p)!]
      )
    )
    const segment = Math.max(...together.map(segmentOf))
    if (newest - own > EDGE_SPREAD_SEGMENTS * segment * 1000) return false
    // Just inside each edge on the wall clock: in media time, stepping back
    // could cross an anchor into footage from before a gap.
    const shared = Math.min(this.wall, ...[...edges.values()].map(e => e - 100))
    if (
      together.some(port => {
        const target = targetTime(port.timeline, shared, port.duration)
        return (
          target?.available !== true ||
          !this.inSeekableRange(port, target.seconds)
        )
      })
    )
      return false
    this.seek(shared)
    return true
  }

  /**
   * A live camera whose footage at the shared moment lies past its safe seek
   * edge and ahead of the frame it decodes: a seek there is refused, and
   * playing on never closes the distance.
   */
  private beyondSafeEdge(port: ClockPort): boolean {
    if (
      this.wall === null ||
      Number.isFinite(port.duration) ||
      port.seekableEnd === null ||
      port.pendingWall !== null
    )
      return false
    const target = targetTime(port.timeline, this.wall, port.duration)
    return (
      target?.available === true &&
      target.seconds >= port.seekableEnd &&
      target.seconds > port.position + 0.75
    )
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

  // Native playback can continue beyond AVPlayer's safe live seek limit.
  // Keep those decoded frames available while transport still obeys that limit.
  available(index: number): boolean {
    const port = this.ports[index]
    if (
      port === undefined ||
      port.failed ||
      port.ended ||
      port.pendingWall !== null
    )
      return false
    if (this.wall === null) return true
    const target = targetTime(port.timeline, this.wall, port.duration)
    return (
      target === null ||
      (target.available &&
        (this.inSeekableRange(port, target.seconds) ||
          (target.seconds >= Math.min(port.seekableStart, port.position) &&
            target.seconds <= port.position + 0.75)))
    )
  }
}
