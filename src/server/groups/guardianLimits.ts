import { type Kysely, sql } from 'kysely'

import { rateLimited } from '../../common/errors'
import type { GuardianTerms } from '../../common/notifications'
import type { Database } from '../db/database'
import type { Clock } from './requests'

const WEEK = 7 * 24 * 3600 * 1000
/** Requests one person may have waiting at once. */
const MOST_PENDING = 5
/** Declines that stop a person asking for a week. */
const DECLINES_TO_BLOCK = 3

/**
 * Whether a guardian row with no sending group is a request — its sender
 * names themselves as the guardian — rather than a guardian's invitation of
 * somebody else. A team's invitation is never a request.
 */
export function isGuardianRequest(request: {
  sender_id: number
  sender_scope_type: string | null
  terms: unknown
}): boolean {
  const { guardian } = request.terms as GuardianTerms
  return (
    request.sender_scope_type == null &&
    'userId' in guardian &&
    guardian.userId === request.sender_id
  )
}

/**
 * The limits on asking to be somebody's guardian.
 *
 * Only what a person sends themselves counts: guardian rows with no sending
 * group, their own requests and, as a guardian, their invitations of
 * somebody else. The invitations a coach sends from a team never count
 * toward the coach's own limits. Expired and withdrawn ones count toward
 * neither.
 *
 * - **Waiting.** Five requests and invitations still pending, and not yet
 *   past their expiry, refuse a sixth until one is answered or expires.
 * - **Declined.** Walking the person's declined requests in the order they
 *   were declined, the third since the last block ended starts a block of
 *   seven days from that decline, and the count starts again. A decline the
 *   sender made of their own request is a withdrawal, and is not counted;
 *   nor is a declined invitation. With `declines: false`, for a guardian's
 *   invitation, a block does not apply at all.
 *
 * Both refusals are `rateLimited`, with how long until asking again would
 * work in `details`.
 */
export async function checkGuardianLimits(
  db: Kysely<Database>,
  senderId: number,
  clock: Clock,
  options: { declines: boolean } = { declines: true }
): Promise<void> {
  const now = clock.now()
  const own = db
    .selectFrom('group_requests')
    .where('sender_id', '=', senderId)
    .where('kind', '=', 'guardian')
    .where('sender_scope_type', 'is', null)
  const pending = await own
    .select('expires_at')
    .where('status', '=', 'pending')
    .where('expires_at', '>', now)
    .orderBy('expires_at')
    .execute()
  if (pending.length >= MOST_PENDING)
    throw rateLimited(
      `You have ${MOST_PENDING} guardian requests waiting. Wait for an answer before asking again.`,
      secondsUntil(pending[0].expires_at, now)
    )
  if (!options.declines) return

  const declined = await own
    .select('resolved_at')
    .where('status', '=', 'declined')
    // Requests only: the sender is the guardian they name.
    .where(sql<string>`terms->'guardian'->>'userId'`, '=', String(senderId))
    .where('resolved_at', 'is not', null)
    .$narrowType<{ resolved_at: Date }>()
    .where('resolved_by', '!=', senderId)
    .orderBy('resolved_at')
    .execute()
  let count = 0
  let blockedUntil: Date | null = null
  for (const { resolved_at: resolvedAt } of declined) {
    if (blockedUntil != null && resolvedAt < blockedUntil) continue
    count += 1
    if (count === DECLINES_TO_BLOCK) {
      blockedUntil = new Date(resolvedAt.getTime() + WEEK)
      count = 0
    }
  }
  if (blockedUntil != null && now < blockedUntil)
    throw rateLimited(
      `Three guardian requests were declined. You can ask again on ${dateText(blockedUntil)}.`,
      secondsUntil(blockedUntil, now)
    )
}

function secondsUntil(when: Date, now: Date): number {
  return Math.ceil((when.getTime() - now.getTime()) / 1000)
}

/** `October 13, 2026`, in UTC: the server does not know the asker's zone. */
function dateText(when: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC'
  }).format(when)
}
