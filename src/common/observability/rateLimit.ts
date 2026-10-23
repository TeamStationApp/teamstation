/** Bounded ephemeral counters; addresses are never persisted or logged. */
export class RateLimit {
  private readonly buckets = new Map<string, { at: number; count: number }>()
  private global = { at: 0, count: 0 }
  constructor(
    private readonly limit = 120,
    private readonly now = Date.now
  ) {}

  allow(key: string): boolean {
    const at = Math.floor(this.now() / 60000)
    if (this.global.at !== at) {
      this.global = { at, count: 0 }
      this.buckets.clear()
    }
    if (++this.global.count > 10000) return false
    let bucket = this.buckets.get(key)
    if (bucket == null) {
      bucket = { at, count: 0 }
      this.buckets.set(key, bucket)
    }
    return ++bucket.count <= this.limit
  }
}
