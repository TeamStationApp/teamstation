import type { RequestHandler } from 'express'
import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import type { Database } from '../db/database'

/**
 * What a route says it changed. A route sets this on `res.locals` so the
 * middleware can record the entity without parsing the path.
 */
export interface AuditSubject {
  entityType?: string
  /** User ids arrive as numbers. The `entity_id` column is text. */
  entityId?: string | number
  before?: unknown
  after?: unknown
}

export function setAudit(
  locals: Record<string, unknown>,
  subject: AuditSubject
): void {
  locals.audit = subject
}

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Writes one row for every write that succeeded. "Update anything through the
 * API" needs "see who changed it", and that is only true if the logging is not
 * left to each route to remember.
 *
 * It runs after the response, so a slow insert never delays the caller, and a
 * failed insert is logged rather than turned into a failed request — losing an
 * audit row is bad, but failing a write the user already saw succeed is worse.
 */
export function withAudit(db: Kysely<Database>): RequestHandler {
  return (req, res, next) => {
    if (READ_ONLY.has(req.method)) {
      next()
      return
    }

    res.on('finish', () => {
      if (res.statusCode >= 400) return
      const subject = (res.locals.audit ?? {}) as AuditSubject
      db.insertInto('audit_log')
        .values({
          id: makeId('audit'),
          actor_user_id: req.actor?.userId ?? null,
          api_token_id: req.actor?.apiTokenId ?? null,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          entity_type: subject.entityType ?? null,
          entity_id: subject.entityId == null ? null : String(subject.entityId),
          before: subject.before ?? null,
          after: subject.after ?? null
        })
        .execute()
        .catch((error: unknown) => {
          console.error('audit log write failed', error)
        })
    })

    next()
  }
}
