// RCTVideo converts JS time to Float, then millisecond CMTime, then Float again.
const nativeTime = (seconds: number): number =>
  Math.fround(Math.round(Math.fround(seconds) * 1000) / 1000)

/** AVPlayer seeks must not overlap: cancelled completions can resume old frames.
 * Keep one native request in flight and coalesce all newer requests to the latest.
 */
export class NativeSeekQueue {
  private active: number | null = null
  private desired = 0
  private position = 0
  private awaitingProgress: number | null = null

  constructor(
    private readonly seek: (seconds: number) => void,
    private readonly settled: () => void
  ) {}

  request(seconds: number): void {
    this.desired = seconds
    if (this.active !== null) return
    if (nativeTime(seconds) === nativeTime(this.position)) {
      // react-native-video does not emit onSeek for a no-op seek.
      this.settled()
      return
    }
    this.active = seconds
    this.seek(seconds)
  }

  complete(seekTime: number, currentTime: number): void {
    if (
      this.active === null ||
      nativeTime(seekTime) !== nativeTime(this.active)
    )
      return
    this.active = null
    this.position = currentTime
    this.awaitingProgress = currentTime
    if (nativeTime(this.desired) !== nativeTime(seekTime))
      this.request(this.desired)
    else this.settled()
  }

  progress(seconds: number): void {
    if (
      this.active !== null ||
      (this.awaitingProgress !== null &&
        Math.abs(seconds - this.awaitingProgress) > 1)
    )
      return
    this.awaitingProgress = null
    this.position = seconds
  }
}
