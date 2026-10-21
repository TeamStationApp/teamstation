import type { Migration } from '../runner'

/**
 * What a queued write from the phone was answered, kept by its
 * `Idempotency-Key`, so the same request sent again is answered the same
 * way and not written twice. `result_id` is what the write made (a new
 * player's user id, a lineup save's digest), stored in the write's own
 * transaction; `status` and `body` are the HTTP answer, stored once it is
 * read, so both are empty in between (and for a live post, always: its
 * answer is read again). Rows expire, and `created_at` is what the sweep
 * that deletes them looks up.
 */
export const migration074SyncIdempotency: Migration = {
  name: '074syncIdempotency',
  up: `
create table sync_idempotency (
  user_id text not null references users(id) on delete cascade,
  key text not null,
  method text not null,
  path text not null,
  request_hash text not null,
  status integer,
  body jsonb,
  result_id text,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index sync_idempotency_created_at on sync_idempotency (created_at);
`,
  down: `
drop table sync_idempotency;
`
}
