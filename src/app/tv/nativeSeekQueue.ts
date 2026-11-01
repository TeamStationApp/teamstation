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
    if (Math.abs(seconds - this.position) < 0.001) {
      // react-native-video does not emit onSeek for a no-op seek.
      this.settled()
      return
    }
    this.active = seconds
    this.seek(seconds)
  }

  complete(seekTime: number, currentTime: number): void {
    if (this.active === null || Math.abs(seekTime - this.active) > 0.001) return
    this.active = null
    this.position = currentTime
    this.awaitingProgress = currentTime
    if (Math.abs(this.desired - seekTime) > 0.001) this.request(this.desired)
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
