import type { Migration } from '../runner'

/**
 * API keys a person makes for themselves under Account, to call the same API
 * the app calls. Separate from `api_tokens`, which are the Distributor's and
 * the Director's machine tokens and keep every refusal they have.
 *
 * A key is looked up by the hash of its secret, like a session. The secret is
 * also kept sealed under the server's `sessionSecret`, so Account can copy it
 * again on a later visit while a copy of the database alone does not give it
 * away. `permissions` holds `<area>:read` and `<area>:write`; a write is
 * always stored with its read. A key does not expire; revoking it, or
 * signing the account out everywhere, ends it.
 *
 * An audit row of a write made with a key names the key, never its secret.
 */
export const migration089UserApiKeys: Migration = {
  name: '089userApiKeys',
  up: `
create table user_api_keys (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  token_hash text not null unique,
  secret_sealed text not null,
  permissions text[] not null check (cardinality(permissions) > 0),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index user_api_keys_active on user_api_keys (user_id, created_at)
  where revoked_at is null;
alter table audit_log
  add column user_api_key_id text references user_api_keys (id) on delete set null;
`,
  down: `
alter table audit_log drop column user_api_key_id;
drop table user_api_keys;
`
}
