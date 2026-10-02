import type { Migration } from '../runner'

/**
 * Drops the two season caches.
 *
 * `team_season_records` held each team's W-L-T and runs per season, and
 * `player_season_stats` each player's totals per team and season. Both were
 * copies of what the games and `game_player_stats` already say, refilled only
 * when somebody ran the demo or merge-team script, so a scored game moved
 * every player figure and no team's record. A record is now counted from the
 * finished games on every read (`server/stats/records.ts`) and a player's
 * teams and seasons from their stat lines, so nothing reads either table.
 *
 * Down puts both back exactly as 047 left them, empty: whatever they held was
 * stale, and nothing reads them after this migration.
 */
export const migration048DropStatRollups: Migration = {
  name: '048dropStatRollups',
  up: `
drop table team_season_records;
drop table player_season_stats;
`,
  down: `
create table player_season_stats (
  id text primary key,
  user_id bigint not null references users (id) on delete cascade,
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
`
}
