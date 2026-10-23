import type { Migration } from '../runner'

/**
 * Tess, the assistant. Each person has one conversation: its messages as the
 * Messages API takes them, the summary that stands in for the turns
 * compaction removed, the files they attached, the changes she proposed and
 * they may confirm, and the tokens it used each UTC week.
 *
 * A change is `running` from `started_at` until the server has answered it;
 * one still running long after its request's deadline was lost with its
 * worker, and is `unknown`.
 *
 * Usage is a table rather than a counter in memory because every core runs
 * its own worker, and so is the claim a turn holds on its conversation
 * (`turn_owner` until `turn_until`), which keeps a person's turns one at a
 * time across workers. Every row belongs to one person and goes with them:
 * `on delete cascade` here, and account deletion, which keeps the `users`
 * row, deletes them itself.
 */
export const migration085Tess: Migration = {
  name: '085tess',
  up: `
create table tess_conversations (
  user_id text primary key references users(id) on delete cascade,
  summary text,
  context_tokens integer not null default 0 check (context_tokens >= 0),
  turn_owner uuid,
  turn_until timestamptz,
  updated_at timestamptz not null default now()
);
create table tess_messages (
  id bigserial primary key,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content jsonb not null,
  created_at timestamptz not null default now()
);
create index tess_messages_user on tess_messages(user_id, id);
create table tess_attachments (
  id uuid primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  media_type text not null,
  kind text not null check (kind in ('image','csv','text','markdown')),
  data bytea,
  description text,
  created_at timestamptz not null default now(),
  constraint tess_attachments_content
    check (data is not null or description is not null)
);
create index tess_attachments_user on tess_attachments(user_id, created_at);
create table tess_changes (
  id uuid primary key,
  user_id text not null references users(id) on delete cascade,
  method text not null check (method in ('POST','PUT','PATCH','DELETE')),
  path text not null,
  body jsonb,
  summary text not null,
  status text not null default 'pending'
    check (status in ('pending','running','done','failed','expired','unknown')),
  result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  started_at timestamptz
);
create index tess_changes_user on tess_changes(user_id, status);
create table tess_usage_weeks (
  user_id text not null references users(id) on delete cascade,
  week_start date not null
    constraint tess_usage_weeks_monday check (extract(isodow from week_start) = 1),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  requests integer not null default 0 check (requests >= 0),
  primary key (user_id, week_start)
);
`,
  down: `
drop table tess_usage_weeks;
drop table tess_changes;
drop table tess_attachments;
drop table tess_messages;
drop table tess_conversations;
`
}
