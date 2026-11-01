// RCTVideo converts JS time to Float, then millisecond CMTime, then Float again.
const nativeTime = (seconds: number): number =>
  Math.fround(Math.round(Math.fround(seconds) * 1000) / 1000)

/** AVPlayer seeks must not overlap: cancelled completions can resume old frames.
 * Keep one native request in flight and coalesce all newer requests to the latest.
 */
export class NativeSeekQueue {
  private active: number | null = null
  private desired = 0

  constructor(
    private readonly seek: (seconds: number) => void,
    private readonly settled: () => void
  ) {}

  request(seconds: number): void {
    this.desired = seconds
    if (this.active !== null) return
    // Always ask native: playback may have moved since the last JS event.
    // The pinned native no-op patch guarantees acknowledgement in that case.
    this.active = seconds
    this.seek(seconds)
  }

  complete(seekTime: number): void {
    if (
      this.active === null ||
      nativeTime(seekTime) !== nativeTime(this.active)
    )
      return
    this.active = null
    if (nativeTime(this.desired) !== nativeTime(seekTime))
      this.request(this.desired)
    else this.settled()
  }
}
