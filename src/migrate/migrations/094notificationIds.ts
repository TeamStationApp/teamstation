import { Kysely, PostgresDialect } from 'kysely'
import type { PoolClient } from 'pg'

import type { Database } from '../../server/db/database'
import type { StoredRequest } from '../../server/groups/requests'
import { frozenNamesOf } from '../../server/notifications/requestInformation'
import { type Migration, STEP_BATCH } from '../runner'

/**
 * Notifications keep no person's name. What they say about a person is
 * rendered when the inbox is read, from `users`:
 *
 * - A request's notification (`groupRequest`) keeps the sending group's name
 *   and freezes the group names and season zones its text reads, as they
 *   stand now (`metadata.frozen`); the sender's name, the title and
 *   description written with it, and the flags saying which game details that
 *   text held go. Its text is rendered from the request's terms.
 * - A grant's notification keeps what was given, and where (`scope`,
 *   `roles`); its title and description go.
 * - A venue claim a person decided keeps who decided (its actor) and gains the
 *   claim's kind and the league's name (`claimKind`, `leagueName`); its
 *   description, which named the decider, goes. One decided by the seven days
 *   passing names nobody and stays.
 *
 * Names cannot be put back: rolling back raises.
 */

/** A Kysely over the migration's own connection, inside its transaction. */
function onClient(client: PoolClient): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: {
        // The connection stays the migration's: Kysely never releases it.
        connect: async () => ({
          query: client.query.bind(client),
          release: () => {}
        }),
        end: async () => {},
        options: {}
      }
    })
  })
}

/** Freezes the group names and zones of every request's notification. */
async function freezeRequests(client: PoolClient): Promise<number> {
  const db = onClient(client)
  let after: string | null = null
  let written = 0
  for (;;) {
    const rows: Array<{ eventId: string } & StoredRequest> = await db
      .selectFrom('notification_events')
      .innerJoin(
        'group_requests',
        'group_requests.id',
        'notification_events.source_id'
      )
      .selectAll('group_requests')
      .select('notification_events.id as eventId')
      .where('notification_events.source_type', '=', 'groupRequest')
      .$if(after != null, query =>
        query.where('notification_events.id', '>', after!)
      )
      .orderBy('notification_events.id')
      .limit(STEP_BATCH)
      .execute()
    for (const { eventId, ...request } of rows) {
      const frozen = await frozenNamesOf(db, request)
      await client.query(
        `update notification_events
         set metadata = metadata || jsonb_build_object('frozen', $2::jsonb)
         where id = $1 and not (metadata ? 'frozen')`,
        [eventId, JSON.stringify(frozen)]
      )
      written++
    }
    if (rows.length < STEP_BATCH) return written
    after = rows[rows.length - 1].eventId
  }
}

export const migration094NotificationIds: Migration = {
  name: '094notificationIds',
  up: `
update notification_events
set metadata = metadata - 'senderName' - 'requestTitle' - 'requestDescription'
  - 'gameClassificationIncluded' - 'gameEventDetailsIncluded'
  - 'gameScheduleDetailsIncluded'
where source_type = 'groupRequest'
  and metadata ?| array['senderName', 'requestTitle', 'requestDescription',
    'gameClassificationIncluded', 'gameEventDetailsIncluded',
    'gameScheduleDetailsIncluded'];

update notification_events
set metadata = metadata - 'title' - 'description'
where source_type = 'grant'
  and metadata ? 'scope'
  and metadata ?| array['title', 'description'];

update notification_events
set metadata = metadata - 'description'
where source_type = 'venueClaimDecided'
  and actor_id is not null
  and metadata ? 'description';
`,
  steps: async client => {
    await freezeRequests(client)
    // A claim a person decided: its kind and its league's name, as the
    // claim row reads now.
    await client.query(`
update notification_events event
set metadata = event.metadata || jsonb_build_object(
  'claimKind', case when claim.kind = 'coOwner' then 'request' else 'claim' end,
  'leagueName', coalesce(league.name, 'A league')
)
from notification_events decided
left join venue_claims claim on claim.id = decided.metadata->>'claimId'
left join leagues league on league.id = claim.league_id
where event.id = decided.id
  and event.source_type = 'venueClaimDecided'
  and event.actor_id is not null
  and not (event.metadata ? 'claimKind')`)
  },
  down: `do $restore$ begin
    raise exception 'Restore the verified pre-cutover backup and matching code; names taken out of notifications cannot be put back';
  end $restore$;`
}
