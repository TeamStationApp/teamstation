import type { Migration } from '../runner'

export const migration050OAuth: Migration = {
  name: '050oauth',
  up: `
create table oauth_records (
  model text not null,
  id_hash text not null,
  payload text not null,
  expires_at timestamptz,
  consumed_at timestamptz,
  uid_hash text,
  user_code_hash text,
  grant_hash text,
  primary key (model, id_hash)
);
create index oauth_records_expiry on oauth_records (expires_at);
create index oauth_records_uid on oauth_records (model, uid_hash);
create index oauth_records_user_code on oauth_records (model, user_code_hash);
create index oauth_records_grant on oauth_records (grant_hash);
create table oauth_grant_sessions (
  grant_hash text primary key,
  client_id text not null,
  user_id bigint not null references users(id) on delete cascade,
  session_id text not null references auth_sessions(id) on delete cascade
);
create index oauth_grant_sessions_identity on oauth_grant_sessions (user_id, client_id);
create table oauth_approvals (
  handle_hash text primary key,
  interaction_id text not null unique,
  expires_at timestamptz not null,
  decision text not null default 'pending' check (decision in ('pending', 'approved', 'denied')),
  user_id bigint references users(id) on delete cascade,
  session_id text references auth_sessions(id) on delete cascade,
  consumed_at timestamptz
);
create index oauth_approvals_expiry on oauth_approvals (expires_at);
create table oauth_decisions (
  interaction_id text primary key,
  expires_at timestamptz not null
);
`,
  down: `drop table oauth_decisions; drop table oauth_approvals; drop table oauth_grant_sessions; drop table oauth_records;`
}
