import type { Migration } from '../runner'

/**
 * Games, their videos, and the play stream underneath them.
 *
 * A game carries its own `season_id` because a team can play in two seasons at
 * once, so the season cannot be inferred from the teams alone.
 */
export const migration002Content: Migration = {
  name: '002content',
  up: `
create table games (
  id text primary key,
  home_team_id text not null references teams (id) on delete restrict,
  away_team_id text not null references teams (id) on delete restrict,
  season_id text references seasons (id) on delete set null,
  start_at timestamptz not null,
  venue text,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'inProgress', 'final', 'cancelled')),
  home_score integer,
  away_score integer,
  gumbo_game_data jsonb,
  linescore jsonb,
  boxscore jsonb,
  ingest_status text not null default 'none'
    check (ingest_status in ('none', 'ok', 'scoreMismatch', 'error')),
  ingest_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index games_start_at on games (start_at desc);
create index games_home_team on games (home_team_id, start_at desc);
create index games_away_team on games (away_team_id, start_at desc);
create index games_season on games (season_id, start_at desc)
  where season_id is not null;

create table videos (
  id text primary key,
  game_id text references games (id) on delete set null,
  kind text not null check (kind in ('program', 'combined')),
  title text not null,
  storage text not null check (storage in ('peertube', 'local', 'spaces')),
  status text not null default 'processing'
    check (status in ('live', 'processing', 'ready', 'unavailable', 'error')),
  status_message text,
  start_at timestamptz,
  start_at_source text check (start_at_source in (
    'obsFilename', 'liveSession', 'originallyPublishedAt', 'distributor',
    'manual'
  )),
  sync_offset_sec integer not null default 0,
  duration_sec double precision,
  width integer,
  height integer,
  codecs text,
  probed_master_mtime timestamptz,
  size_bytes bigint,
  sha256 text,
  spaces_verified_at timestamptz,
  local_delete_after timestamptz,
  legacy_description text,
  published_at timestamptz,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index videos_game on videos (game_id);
create index videos_pending_delete on videos (local_delete_after)
  where local_delete_after is not null;

-- One row per play, holding the GUMBO entry it came from.
create table events (
  id text primary key,
  game_id text not null references games (id) on delete cascade,
  at_bat_index integer not null,
  start_time timestamptz,
  end_time timestamptz,
  inning integer,
  half_inning text check (half_inning in ('top', 'bottom')),
  batting_team_id text references teams (id) on delete set null,
  event_type text,
  description text,
  is_scoring_play boolean not null default false,
  rbi integer not null default 0,
  away_score integer,
  home_score integer,
  gumbo jsonb not null,
  source text not null default 'external'
    check (source in ('external', 'manual')),
  hidden boolean not null default false,
  title_override text,
  time_nudge_sec integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, at_bat_index)
);
create index events_game_order on events (game_id, at_bat_index);
create index events_scoring on events (game_id) where is_scoring_play;

create table event_players (
  id text primary key,
  event_id text not null references events (id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  team_id text references teams (id) on delete set null,
  role text not null check (role in (
    'batter', 'pitcher', 'runner', 'scorer', 'fielder', 'catcher'
  )),
  position text,
  unique (event_id, user_id, role)
);
-- "Every highlight of Jensen" is one indexed lookup across all their teams.
create index event_players_user on event_players (user_id);
create index event_players_user_team on event_players (user_id, team_id);
`,
  down: `
drop table if exists event_players;
drop table if exists events;
drop table if exists videos;
drop table if exists games;
`
}
