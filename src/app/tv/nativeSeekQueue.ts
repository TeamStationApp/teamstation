// RCTVideo converts JS time to Float, then millisecond CMTime, then Float again.
const nativeTime = (seconds: number): number =>
  Math.fround(Math.round(Math.fround(seconds) * 1000) / 1000)

/** AVPlayer seeks must not overlap: cancelled completions can resume old frames.
 * Keep one native request in flight and coalesce all newer requests to the latest.
 */
export class NativeSeekQueue {
  private active: number | null = null
  private desired = 0
  private requestedAt = 0
  private timeoutReported = false
  private buffering = false
  private readySince = 0

  get pending(): boolean {
    return this.active !== null && !this.timeoutReported
  }

  /**
   * Leaving buffering gives a ready decoder a fresh acknowledgement window.
   * Only a request or a transfer restarts the two-minute buffering bound, so
   * a decoder flipping in and out of buffering cannot hold a seek for ever.
   */
  buffer(isBuffering: boolean): void {
    if (this.buffering && !isBuffering) this.readySince = this.now()
    this.buffering = isBuffering
  }

  transferProgress(): void {
    if (this.pending && this.buffering) this.requestedAt = this.now()
  }

  /** An explicit decoder error supersedes any outstanding seek. */
  fail(): void {
    this.active = null
    this.timeoutReported = true
  }

  constructor(
    private readonly seek: (seconds: number) => void,
    private readonly settled: () => void,
    private readonly now: () => number = Date.now
  ) {}

  request(seconds: number): void {
    this.desired = seconds
    if (this.active !== null) return
    // Always ask native: playback may have moved since the last JS event.
    // The pinned native no-op patch guarantees acknowledgement in that case.
    this.active = seconds
    this.requestedAt = this.now()
    this.timeoutReported = false
    this.seek(seconds)
  }

  /** A lost completion is a source failure even while the viewer is paused. */
  timedOut(): boolean {
    const now = this.now()
    if (
      this.active === null ||
      this.timeoutReported ||
      (now - this.requestedAt < 120_000 &&
        (this.buffering ||
          now - Math.max(this.requestedAt, this.readySince) < 5000))
    )
      return false
    this.timeoutReported = true
    return true
  }

  complete(seekTime: number): void {
    if (
      this.active === null ||
      this.timeoutReported ||
      nativeTime(seekTime) !== nativeTime(this.active)
    )
      return
    this.active = null
    if (nativeTime(this.desired) !== nativeTime(seekTime))
      this.request(this.desired)
    else this.settled()
  }
}
