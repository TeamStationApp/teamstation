import type { Migration } from '../runner'

/**
 * Sign-in, audit, settings, and the stat rollups.
 *
 * The rollups are derived from `events` and are safe to drop and recompute;
 * the plays stay the only source of truth.
 */
export const migration003Operations: Migration = {
  name: '003operations',
  up: `
create table auth_sessions (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  token_hash text not null unique,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index auth_sessions_user on auth_sessions (user_id);
create index auth_sessions_expiry on auth_sessions (expires_at)
  where revoked_at is null;

-- Long-lived tokens for the Distributor and Director, not for people.
create table api_tokens (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  label text not null,
  token_hash text not null unique,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
create index api_tokens_user on api_tokens (user_id);

-- Six-digit codes for e-mail sign-in. Hashed, single use, short lived.
create table email_codes (
  id text primary key,
  email text not null,
  code_hash text not null,
  purpose text not null check (purpose in ('login', 'verify', 'reset')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index email_codes_email on email_codes (lower(email), purpose);

create table audit_log (
  id text primary key,
  at timestamptz not null default now(),
  actor_user_id text references users (id) on delete set null,
  api_token_id text references api_tokens (id) on delete set null,
  method text not null,
  path text not null,
  entity_type text,
  entity_id text,
  before jsonb,
  after jsonb
);
create index audit_log_at on audit_log (at desc);
create index audit_log_entity on audit_log (entity_type, entity_id, at desc);
create index audit_log_actor on audit_log (actor_user_id, at desc);

create table system_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text references users (id) on delete set null
);

-- Highlights are computed at read time, so changing one of these moves every
-- highlight in every game at once. There is no per-team or per-highlight lead.
insert into system_settings (key, value) values
  ('highlights.lagSec', '8'::jsonb),
  ('highlights.leadSec', '30'::jsonb),
  ('highlights.leadSecByEventType', '{"strikeout": 10}'::jsonb);

create table player_season_stats (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  season_id text references seasons (id) on delete cascade,
  team_id text not null references teams (id) on delete cascade,
  g integer not null default 0,
  pa integer not null default 0,
  ab integer not null default 0,
  h integer not null default 0,
  singles integer not null default 0,
  doubles integer not null default 0,
  triples integer not null default 0,
  hr integer not null default 0,
  r integer not null default 0,
  rbi integer not null default 0,
  bb integer not null default 0,
  k integer not null default 0,
  sb integer not null default 0,
  cs integer not null default 0,
  pitch_appearances integer not null default 0,
  pitch_outs_recorded integer not null default 0,
  pitch_h integer not null default 0,
  pitch_r integer not null default 0,
  pitch_bb integer not null default 0,
  pitch_k integer not null default 0,
  field_po integer not null default 0,
  field_a integer not null default 0,
  field_e integer not null default 0,
  computed_at timestamptz not null default now()
);
create unique index player_season_stats_key
  on player_season_stats (user_id, coalesce(season_id, ''), team_id);
create index player_season_stats_season on player_season_stats (season_id);

create table team_season_records (
  id text primary key,
  team_id text not null references teams (id) on delete cascade,
  season_id text references seasons (id) on delete cascade,
  w integer not null default 0,
  l integer not null default 0,
  t integer not null default 0,
  runs_for integer not null default 0,
  runs_against integer not null default 0,
  computed_at timestamptz not null default now()
);
create unique index team_season_records_key
  on team_season_records (team_id, coalesce(season_id, ''));
`,
  down: `
drop table if exists team_season_records;
drop table if exists player_season_stats;
drop table if exists system_settings;
drop table if exists audit_log;
drop table if exists email_codes;
drop table if exists api_tokens;
drop table if exists auth_sessions;
`
}
