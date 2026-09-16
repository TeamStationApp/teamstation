import { asNumber, asObject } from 'cleaners'
import type { Kysely } from 'kysely'

import type { Database } from './db/database'

/**
 * System-wide settings, which only an administrator changes. Highlights are
 * computed when they are read, so moving `lagSec` or `leadSec` moves every
 * highlight in every game at once; there is deliberately no per-team or
 * per-highlight value to drift out of step.
 */
export interface HighlightSettings {
  /** How long after the play the scorekeeper's tap lands, in seconds. */
  lagSec: number
  /** How long before the play a highlight starts, in seconds. */
  leadSec: number
  /** Exceptions by GUMBO event type, e.g. a shorter lead for a strikeout. */
  leadSecByEventType: Record<string, number>
}

export const defaultHighlightSettings: HighlightSettings = {
  lagSec: 8,
  leadSec: 30,
  leadSecByEventType: { strikeout: 10 }
}

const asLeadMap = asObject(asNumber)

export const asHighlightSettings = asObject({
  lagSec: asNumber,
  leadSec: asNumber,
  leadSecByEventType: asLeadMap
})

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
 * Reads the settings, falling back to the defaults for anything missing or
 * malformed rather than failing a page. A bad value in the database should
 * make highlights slightly wrong, not take the site down.
 */
export async function highlightSettings(
  db: Kysely<Database>
): Promise<HighlightSettings> {
  const now = Date.now()
  if (cache != null && now - cache.at < CACHE_MS) return cache.value

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
    )
  }

  cache = { at: now, value }
  return value
}

function numberOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

function leadMapOr(
  raw: unknown,
  fallback: Record<string, number>
): Record<string, number> {
  try {
    return asLeadMap(raw)
  } catch {
    return fallback
  }
}
