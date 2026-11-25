import { measureOffset } from '../../common/serverClock'
import { whenBack } from '../sync/whenBack'
import type { PreferenceStorage } from './scoringPreferenceStore'

const KEY = 'teamstation:scoring:serverClockOffset'

export interface ServerClockOptions {
  /** This device's clock. Swapped out in tests. */
  local?: () => number
  /**
   * Runs its argument once the network or the app comes back, and returns
   * the way to stop waiting: `whenBack` unless given.
   */
  whenBack?: (again: () => void) => () => void
}

/**
 * The server's clock as this device reads it: its own clock plus the offset
 * last measured against `GET /time`, so every action is stamped on the
 * server's clock whichever device scored it. The offset is kept on the device
 * for scoring offline; one never measured is 0, the device's own clock.
 */
export class ServerClock {
  private offsetMs = 0
  private measured = false
  private readonly local: () => number
  private readonly whenBack: (again: () => void) => () => void
  /** The offset kept from an earlier measurement, read once. */
  readonly restored: Promise<void>

  constructor(
    private readonly fetchTime: () => Promise<number>,
    private readonly storage: PreferenceStorage,
    options: ServerClockOptions = {}
  ) {
    this.local = options.local ?? Date.now
    this.whenBack = options.whenBack ?? whenBack
    this.restored = storage
      .getItem(KEY)
      .then(raw => {
        const kept = Number(raw)
        // A measurement that came back first is newer than the one kept.
        if (!this.measured && raw != null && Number.isFinite(kept))
          this.offsetMs = kept
      })
      .catch(() => undefined)
  }

  /** What to add to this device's clock to read the server's, in ms. */
  get offset(): number {
    return this.offsetMs
  }

  now(): Date {
    return new Date(this.local() + this.offsetMs)
  }

  /**
   * Measures the offset now and keeps it; offline, the last one stands. Once
   * `stopped` says so, no further reading is asked for.
   */
  async measure(stopped: () => boolean = () => false): Promise<void> {
    const fetchTime = async (): Promise<number> => {
      if (stopped()) throw new Error('Stopped keeping time')
      return await this.fetchTime()
    }
    try {
      const sample = await measureOffset(fetchTime, 5, this.local)
      this.offsetMs = Math.round(sample.offsetMs)
      this.measured = true
      await this.storage.setItem(KEY, String(this.offsetMs))
    } catch {
      // Offline: the offset last measured stands.
    }
  }

  /**
   * Measures now, and again each time the network or the app comes back,
   * until the returned function is called: the scoring screen keeps time
   * this way while it is open. A clock that drifts by seconds over a game
   * needs no more than that. A measurement under way when it is called asks
   * for no further reading, so a screen closed on a link that answers nothing
   * starts no new request.
   */
  keepTime(): () => void {
    let stopped = false
    let stop: (() => void) | undefined
    const measure = (): void => {
      this.measure(() => stopped).catch(() => undefined)
      stop = this.whenBack(measure)
    }
    measure()
    return () => {
      stopped = true
      stop?.()
    }
  }
}
