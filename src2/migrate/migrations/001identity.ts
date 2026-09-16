import type { Migration } from '../runner'

/**
 * People, the organisations they belong to, and the links between them.
 *
 * Ids are text with a short prefix (`usr_`, `tem_`, …) so a stray id in a log
 * says what it is. Enumerations are `text` with a check constraint rather than
 * a Postgres enum, because adding a value to a check is one statement and
 * adding one to an enum is not reversible.
 */
export const migration001Identity: Migration = {
  name: '001identity',
  up: `
create table users (
  id text primary key,
  display_name text not null,
  first_name text,
  last_name text,
  email text,
  username text,
  password_hash text,
  login_enabled boolean not null default false,
  is_admin boolean not null default false,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email)) where email is not null;
create unique index users_username_key on users (lower(username)) where username is not null;
-- "Search by player name" is a trigram lookup over the display name.
create extension if not exists pg_trgm;
create index users_display_name_trgm on users using gin (display_name gin_trgm_ops);

create table user_links (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  related_user_id text not null references users (id) on delete cascade,
  kind text not null check (kind in ('guardian', 'family', 'other')),
  can_manage boolean not null default false,
  created_at timestamptz not null default now(),
  constraint user_links_not_self check (user_id <> related_user_id),
  unique (user_id, related_user_id, kind)
);
create index user_links_related on user_links (related_user_id);

create table leagues (
  id text primary key,
  name text not null,
  short_name text,
  website text,
  logo_path text,
  notes text,
  spectator_access text not null default 'team'
    check (spectator_access in ('team', 'league')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table seasons (
  id text primary key,
  league_id text not null references leagues (id) on delete cascade,
  name text not null,
  age_group text,
  year integer not null,
  term text,
  starts_on date,
  ends_on date,
  spectator_access text not null default 'team'
    check (spectator_access in ('team', 'season')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index seasons_league on seasons (league_id, year);

create table teams (
  id text primary key,
  name text not null,
  short_name text,
  sport text not null default 'baseball',
  is_managed boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  logo_path text,
  primary_color text,
  secondary_color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index teams_name_trgm on teams using gin (name gin_trgm_ops);

-- A team plays in any number of seasons and keeps one roster and history.
create table season_teams (
  season_id text not null references seasons (id) on delete cascade,
  team_id text not null references teams (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (season_id, team_id)
);
create index season_teams_team on season_teams (team_id);

create table memberships (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  team_id text not null references teams (id) on delete cascade,
  role text not null default 'member'
    check (role in ('owner', 'manager', 'member')),
  is_player boolean not null default false,
  is_spectator boolean not null default false,
  jersey text,
  positions text[] not null default '{}',
  joined_at timestamptz not null default now(),
  granted_by_link_id text references user_links (id) on delete set null,
  unique (user_id, team_id)
);
create index memberships_team on memberships (team_id);
create index memberships_granted_by on memberships (granted_by_link_id)
  where granted_by_link_id is not null;

create table admin_roles (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  scope_type text not null check (scope_type in ('league', 'season', 'team')),
  scope_id text not null,
  role text not null default 'admin' check (role in ('admin')),
  granted_by text references users (id) on delete set null,
  granted_at timestamptz not null default now(),
  unique (user_id, scope_type, scope_id)
);
create index admin_roles_scope on admin_roles (scope_type, scope_id);

-- One table for every foreign key, unique on the external key and never on
-- the GameStation entity: a child on two teams elsewhere has two player ids.
create table external_ids (
  id text primary key,
  entity_type text not null,
  entity_id text not null,
  system text not null check (system in ('peertube', 'external')),
  kind text not null,
  external_id text not null,
  created_at timestamptz not null default now(),
  unique (system, kind, external_id)
);
create index external_ids_entity on external_ids (entity_type, entity_id);
`,
  down: `
drop table if exists external_ids;
drop table if exists admin_roles;
drop table if exists memberships;
drop table if exists season_teams;
drop table if exists teams;
drop table if exists seasons;
drop table if exists leagues;
drop table if exists user_links;
drop table if exists users;
`
}
