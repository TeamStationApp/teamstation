import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'
import { ensureHistoryAccess } from './historyAccess'

/** Reconcile fixed closed segments under the conversation row lock. */
export async function reconcileHistoryRequests(
  db: Kysely<Database>,
  id: string,
  now: Date
): Promise<void> {
  await ensureHistoryAccess(db, id)
  await sql`
    update chat_history_requests r set superseded_at=${now}
    where r.conversation_id=${id} and r.filled_at is null and r.superseded_at is null
      and not exists (
        select 1 from chat_members m join chat_identities i on i.user_id=m.user_id and i.replaced_at is null
        join chat_user_keys k on k.user_id=i.user_id and k.identity_id=i.id
        where m.conversation_id=r.conversation_id and m.user_id=r.user_id and m.left_at is null
          and i.id=r.identity_id and k.generation=r.generation
          and not exists(select 1 from chat_user_keys newer where newer.identity_id=k.identity_id and newer.generation>k.generation)
      )
  `.execute(db)
  await sql`
    with segments as (
      select epoch as start, lead(epoch) over(order by epoch)-1 as tip
      from chat_epochs where conversation_id=${id} and (epoch=1 or chain_break)
    ), recipients as (
      select m.user_id,i.id as identity_id,max(k.generation) as generation
      from chat_members m join chat_identities i on i.user_id=m.user_id and i.replaced_at is null
      join chat_user_keys k on k.identity_id=i.id and k.user_id=i.user_id
      where m.conversation_id=${id} and m.left_at is null group by m.user_id,i.id
    ), missing as (
      select p.*,s.start,s.tip,coalesce((select max(b.epoch) from chat_epoch_boxes b
        where b.conversation_id=${id} and b.user_id=p.user_id and b.identity_id=p.identity_id
          and b.epoch between s.start and s.tip),s.start-1) as covered
      from recipients p cross join segments s where s.tip is not null
    )
    insert into chat_history_requests(conversation_id,user_id,identity_id,generation,
      segment_start_epoch,target_epoch,covered_through_epoch,opened_at)
    select ${id},user_id,identity_id,generation,start,tip,covered,${now} from missing where covered<tip
    on conflict (conversation_id,user_id,identity_id,generation,target_epoch)
      where filled_at is null and superseded_at is null do nothing
  `.execute(db)
  // A box may also have arrived through a compatible legacy grant. Recompute
  // only this target's prefix, and never infer reachability across a break.
  await sql`
    with coverage as (
      select r.id,greatest(r.covered_through_epoch,coalesce(max(b.epoch),r.segment_start_epoch-1)) as covered
      from chat_history_requests r left join chat_epoch_boxes b
        on b.conversation_id=r.conversation_id and b.user_id=r.user_id and b.identity_id=r.identity_id
          and b.epoch between r.segment_start_epoch and r.target_epoch
      where r.conversation_id=${id} and r.filled_at is null and r.superseded_at is null group by r.id
    )
    update chat_history_requests r set covered_through_epoch=c.covered,
      filled_at=case when c.covered=r.target_epoch then ${now}::timestamptz else null end
    from coverage c where c.id=r.id
  `.execute(db)
}
