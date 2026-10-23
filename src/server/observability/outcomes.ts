import { randomUUID } from 'node:crypto'

import type { Kysely } from 'kysely'

import { parseEvent, type Property } from '../../common/observability/contract'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { storeAnalytics } from './analytics'

/** Called after committed business outcomes. Analytics failure cannot undo the operation. */
export async function recordOutcome(
  db: Kysely<Database>,
  app: unknown,
  actor: Pick<Actor, 'userId' | 'isAdmin'>,
  event:
    'account_created' | 'logout' | 'processing_ready' | 'processing_failed',
  properties: Record<string, Property> = {}
): Promise<void> {
  if (app !== 'TS' && app !== 'TS web') return
  try {
    const row = parseEvent({
      D: new Date().toISOString(),
      A: app,
      I: randomUUID(),
      E: event,
      L: 'info',
      R: 1,
      P: properties
    })
    await storeAnalytics(db, [row], { ...actor, scopes: [] }, true)
  } catch {
    /* Never turn a completed signup, logout or upload into an error. */
  }
}
