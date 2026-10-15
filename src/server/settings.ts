import type { Kysely } from 'kysely'

import {
  asLeadMap,
  asSeconds,
  defaultHighlightTimings,
  type HighlightTimings
} from '../common/nodeSettings'
import type { Database } from './db/database'

/**
 * System-wide settings, which only an administrator changes. Highlights are
 * computed when they are read, so moving `lagSec` or `leadSec` moves every
 * highlight in every game at once; there is deliberately no per-team or
 * per-highlight value to drift out of step. The node administration screen
 * edits them with the scoreboard's (`common/nodeSettings.ts`).
 */
export type HighlightSettings = HighlightTimings

/** The node's defaults, shared with the node administration screen. */
export const defaultHighlightSettings: HighlightSettings =
  defaultHighlightTimings

const CACHE_MS = 30000

interface Cached {
  at: number
  value: HighlightSettings
}

let cache: Cached | undefined

/** Forgets the cached copy. Called after a settings write. */
export function forgetSettings(): void {
  cache = undefined
}

/**
 * Reads the settings, falling back to the default for each value missing or
 * malformed rather than failing a page. A bad value in the database should
 * make highlights slightly wrong, not take the site down. A value is good by
 * the rules the node administration screen holds it to (`asSeconds`,
 * `asLeadMap`), so the screen can always show what this reads.
 */
export async function highlightSettings(
  db: Kysely<Database>,
  /** Read the rows even when the cache is current, and cache what they say. */
  fresh = false
): Promise<HighlightSettings> {
  const now = Date.now()
  if (!fresh && cache != null && now - cache.at < CACHE_MS) return cache.value

  const rows = await db
    .selectFrom('system_settings')
    .select(['key', 'value'])
    .where('key', 'like', 'highlights.%')
    .execute()

  const byKey = new Map(rows.map(row => [row.key, row.value]))
  const value: HighlightSettings = {
    lagSec: numberOr(
      byKey.get('highlights.lagSec'),
      defaultHighlightSettings.lagSec
    ),
    leadSec: numberOr(
      byKey.get('highlights.leadSec'),
      defaultHighlightSettings.leadSec
    ),
    leadSecByEventType: leadMapOr(
      byKey.get('highlights.leadSecByEventType'),
      defaultHighlightSettings.leadSecByEventType
    ),
    mergeWithinSec: numberOr(
      byKey.get('highlights.mergeWithinSec'),
      defaultHighlightSettings.mergeWithinSec
    )
  }

  cache = { at: now, value }
  return value
}

function numberOr(raw: unknown, fallback: number): number {
  try {
    return asSeconds(raw, 'seconds')
  } catch {
    return fallback
  }
}

function leadMapOr(
  raw: unknown,
  fallback: Record<string, number>
): Record<string, number> {
  try {
    return asLeadMap(raw, 'leads')
  } catch {
    return fallback
  }
}
