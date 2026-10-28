import type { Migration } from '../runner'

/**
 * `chat_dirty` becomes an append-only queue. 052chat kept one row per team,
 * season, league or user and every trigger upserted it, so two transactions
 * that touched the same person or team waited on each other's uncommitted
 * row, whatever else they did: a roster import paused mid-transaction held up
 * an unrelated import of the same people on another team, and imports
 * touching them in opposite orders could deadlock.
 *
 * Now `chat_mark_dirty` only appends a row and notifies, so a mark never
 * waits on another transaction. The reconciler takes every row with
 * `delete … returning` and coalesces repeated marks as it drains, so a queue
 * that grows while it is behind is read once per scope; rows appended while
 * it drains stay for the next drain, and every row is durable until then.
 * An index serves the per-conversation lookup `memberNow` makes.
 *
 * Down coalesces the queue to one row per scope, keeping the latest mark,
 * and puts back the key and the upsert.
 */
export const migration088ChatDirtyQueue: Migration = {
  name: '088chatDirtyQueue',
  up: `
alter table chat_dirty drop constraint chat_dirty_pkey;
create index chat_dirty_scope on chat_dirty (scope_type, scope_id);
create or replace function chat_mark_dirty(kind text, id text) returns void
language plpgsql as $$
begin
  if id is null then
    return;
  end if;
  insert into chat_dirty (scope_type, scope_id, marked_at)
  values (kind, id, now());
  perform pg_notify('chat_dirty', '');
end
$$;
`,
  down: `
create or replace function chat_mark_dirty(kind text, id text) returns void
language plpgsql as $$
begin
  if id is null then
    return;
  end if;
  insert into chat_dirty (scope_type, scope_id, marked_at)
  values (kind, id, now())
  on conflict (scope_type, scope_id) do update
    set marked_at = excluded.marked_at
    where chat_dirty.marked_at is distinct from excluded.marked_at;
  perform pg_notify('chat_dirty', '');
end
$$;
delete from chat_dirty older using chat_dirty newer
  where older.scope_type = newer.scope_type
    and older.scope_id = newer.scope_id
    and (older.marked_at, older.ctid) < (newer.marked_at, newer.ctid);
drop index chat_dirty_scope;
alter table chat_dirty add primary key (scope_type, scope_id);
`
}
