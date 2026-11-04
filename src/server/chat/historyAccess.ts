import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'

/** Called under the conversation lock before any legacy request is closed. */
export async function ensureHistoryAccess(
  db: Kysely<Database>,
  conversationId: string
): Promise<void> {
  await sql`
    insert into chat_history_access(conversation_id,user_id,identity_id,requires_approval)
    select m.conversation_id,m.user_id,i.id,
      (exists(select 1 from chat_grant_requests r where r.conversation_id=m.conversation_id
        and r.user_id=m.user_id and r.identity_id=i.id and r.identity_reset)
       or exists(select 1 from chat_membership_log l where l.conversation_id=m.conversation_id
        and l.user_id=m.user_id and l.event='identityReset' and l.at>=i.created_at))
      and not exists(select 1 from chat_epoch_boxes b where b.conversation_id=m.conversation_id
        and b.user_id=m.user_id and b.identity_id=i.id and b.granted_by_user_id is not null
        and b.granted_by_user_id<>m.user_id
        and exists(select 1 from chat_grant_requests approved
          where approved.conversation_id=b.conversation_id and approved.user_id=b.user_id
            and approved.identity_id=b.identity_id and approved.generation=b.generation
            and approved.identity_reset and approved.superseded_at is null
            and approved.filled_at=b.created_at))
    from chat_members m join chat_identities i on i.user_id=m.user_id and i.replaced_at is null
    where m.conversation_id=${conversationId} and m.left_at is null
    on conflict do nothing
  `.execute(db)
}

export async function approveHistoryAccess(
  db: Kysely<Database>,
  conversationId: string,
  userId: string,
  identityId: string,
  approver: string,
  now: Date
): Promise<void> {
  await db
    .updateTable('chat_history_access')
    .set({
      requires_approval: false,
      approved_by_user_id: approver,
      approved_at: now
    })
    .where('conversation_id', '=', conversationId)
    .where('user_id', '=', userId)
    .where('identity_id', '=', identityId)
    .where('requires_approval', '=', true)
    .execute()
}
