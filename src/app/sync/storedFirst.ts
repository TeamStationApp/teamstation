import type { Cleaner } from 'cleaners'

import type { TeamStationClient } from '../../common/api'
import { documentKeyOf } from './documentKeys'

/**
 * A screen's stored-first paint: what the phone stored for a read draws at
 * once, while the read itself is out (with no signal it answers the same,
 * but only once its deadline has passed). Any answer from the server beats
 * it: the read's own, or another read or live update of the same document
 * the screen takes up. A stored copy that arrives after one is dropped,
 * never drawn over it. The web stores nothing, so it never paints.
 *
 * One per document a screen shows, kept for as long as the screen shows it.
 */
export class StoredFirst {
  private answers = 0

  /** The server answered the document: no stored paint begun before goes. */
  answered(): void {
    this.answers++
  }

  /**
   * Reads what the phone stored for `path` and gives it to `paint`, unless
   * an answer came first or the screen moved on (`current`). Resolves
   * whether it painted; a stored copy that cannot be read paints nothing.
   */
  async paint<T>(
    client: Pick<TeamStationClient, 'cached'>,
    path: string,
    cleaner: Cleaner<T>,
    paint: (stored: T) => void,
    current: () => boolean = () => true
  ): Promise<boolean> {
    const key = documentKeyOf(path)
    if (key == null) return false
    const before = this.answers
    let stored: T | undefined
    try {
      stored = await client.cached(key, cleaner)
    } catch {
      return false
    }
    if (stored == null || before !== this.answers || !current()) return false
    paint(stored)
    return true
  }
}
