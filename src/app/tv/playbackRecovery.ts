/** Per-camera retry state. A ready/load event is not proof of advancing video. */
export class PlaybackRecovery {
  private position: number | null = null
  private advancedAt: number
  private failed = false
  private attempts = 0
  private due = 0
  private began: number | null = null
  exhausted = false

  constructor(now: number) {
    this.advancedAt = now
  }

  progress(seconds: number, now: number): boolean {
    const advanced = this.position != null && seconds > this.position + 0.05
    if (advanced) {
      this.advancedAt = now
      this.failed = false
      this.attempts = 0
      this.began = null
      this.exhausted = false
    }
    this.position = seconds
    return advanced
  }

  readyPaused(now: number): void {
    this.failed = false
    this.advancedAt = now
    this.began = null
    this.attempts = 0
    this.exhausted = false
  }

  error(now: number): void {
    this.failed = true
    this.began ??= now
    if (this.due < now) this.due = now + 1000
  }

  /** Returns once per retry; callers serialize the asynchronous URL refresh. */
  retry(now: number, playing: boolean, ended: boolean): boolean {
    if (this.exhausted || ended) return false
    if (!playing && !this.failed) {
      this.advancedAt = now
      return false
    }
    if (!this.failed && now - this.advancedAt < 20_000) return false
    this.began ??= now
    if (now - this.began >= 5 * 60_000) {
      this.exhausted = true
      return false
    }
    if (now < this.due) return false
    this.failed = true
    this.attempts++
    this.due = now + Math.min(10_000, 1000 * 2 ** this.attempts)
    return true
  }
}
