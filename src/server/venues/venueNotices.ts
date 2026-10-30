import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import type { SchedulingNews } from '../../common/notifications'
import type { Database } from '../db/database'
import { adminRecipients } from '../groups/rights'
import type { ClaimRow } from './ownership'

/**
 * Records one scheduling notice for the people it names. Every notice has an
 * id of its own as its source, so two notices about one thing never collide
 * on `notification_events`' unique source; what it concerns is in its
 * metadata, beside its title and (unless it names a person) its description.
 */
export async function recordNotice(
  db: Kysely<Database>,
  notice: {
    type: SchedulingNews
    actorId: string | null
    recipients: string[]
    title: string
    /** None when the inbox renders it as it is read. */
    description?: string
    metadata: Record<string, string>
  }
): Promise<void> {
  const recipients = [...new Set(notice.recipients)]
  if (recipients.length === 0) return
  const id = makeId('audit')
  await db
    .insertInto('notification_events')
    .values({
      id,
      source_type: notice.type,
      source_id: id,
      revision: 1,
      actor_id: notice.actorId,
      metadata: {
        title: notice.title,
        ...(notice.description == null
          ? {}
          : { description: notice.description }),
        ...notice.metadata
      },
      recorded_recipients: recipients,
      created_at: new Date()
    })
    .execute()
}

/** The site administrators who can sign in. */
async function siteAdministrators(db: Kysely<Database>): Promise<string[]> {
  return (
    await db
      .selectFrom('users')
      .select('id')
      .where('is_admin', '=', true)
      .where('disabled_at', 'is', null)
      .where('merged_into', 'is', null)
      .execute()
  ).map(row => row.id)
}

async function namesOf(
  db: Kysely<Database>,
  claim: ClaimRow
): Promise<{ league: string; venue: string }> {
  const league = await db
    .selectFrom('leagues')
    .select('name')
    .where('id', '=', claim.league_id)
    .executeTakeFirst()
  const venue = await db
    .selectFrom('venues')
    .select('name')
    .where('id', '=', claim.venue_id)
    .executeTakeFirst()
  return { league: league?.name ?? 'A league', venue: venue?.name ?? 'a venue' }
}

/**
 * A new claim: a first claim goes to the site administrators, and a request
 * to co-own goes to them and to the admins of the leagues that own the venue.
 */
export async function noticeClaimFiled(
  db: Kysely<Database>,
  claim: ClaimRow,
  ownerLeagueIds: string[]
): Promise<void> {
  const names = await namesOf(db, claim)
  const metadata = { venueId: claim.venue_id, claimId: claim.id }
  if (claim.kind === 'claim') {
    await recordNotice(db, {
      type: 'venueClaim',
      actorId: claim.requested_by,
      recipients: await siteAdministrators(db),
      title: `${names.league} claimed ${names.venue}`,
      description:
        'Approve or reject within 7 days, or it is approved automatically.',
      metadata
    })
    return
  }
  await recordNotice(db, {
    type: 'venueOwnerRequest',
    actorId: claim.requested_by,
    recipients: [
      ...(await siteAdministrators(db)),
      ...(await adminRecipients(
        db,
        ownerLeagueIds.map(id => ({ kind: 'league' as const, id }))
      ))
    ],
    title: `${names.league} asks to co-own ${names.venue}`,
    description:
      'Approve or decline. It is approved automatically after 7 days.',
    metadata
  })
}

/**
 * A claim decided, by a person or by the seven days passing: the claiming
 * league's admins are told. A person's decision stores who decided (the
 * notice's actor), the claim's kind and the league's name, and the inbox
 * names the decider as they are now; the seven days' says so in words.
 */
export async function noticeClaimDecided(
  db: Kysely<Database>,
  claim: ClaimRow,
  byPerson: boolean
): Promise<void> {
  const names = await namesOf(db, claim)
  const outcome =
    claim.status === 'approved'
      ? 'claim approved'
      : claim.kind === 'claim'
        ? 'claim rejected'
        : 'request declined'
  const claimKind = claim.kind === 'claim' ? 'claim' : 'request'
  await recordNotice(db, {
    type: 'venueClaimDecided',
    actorId: claim.decided_by,
    recipients: await adminRecipients(db, [
      { kind: 'league', id: claim.league_id }
    ]),
    title: `${names.venue}: ${outcome}`,
    description: byPerson
      ? undefined
      : `${names.league}'s ${claimKind} was approved after 7 days.`,
    metadata: {
      venueId: claim.venue_id,
      claimId: claim.id,
      ...(byPerson ? { claimKind, leagueName: names.league } : {})
    }
  })
}
