import type { Migration } from '../runner'

/**
 * What the Auto-Scheduler needs of a season and a league.
 *
 * `season_team_flags` marks a team in a season as an exhibition team. It is
 * its own table because a season's teams come from two places, active
 * participation (`season_teams`) and parent-managed teams
 * (`season_team_parents`); a missing row reads as not an exhibition team.
 *
 * `season_schedule_settings` holds a season's scheduling numbers, and its
 * game windows: a list of periods `{ from, hours }`, each in force from its
 * date until the next. `league_schedule_setups` holds the seasons and fields
 * a league's next schedule is built from.
 */
export const migration079SeasonScheduling: Migration = {
  name: '079seasonScheduling',
  up: `
create table season_team_flags (
  season_id text not null references seasons(id),
  team_id text not null references teams(id),
  exhibition boolean not null default false,
  primary key (season_id, team_id)
);
create table season_schedule_settings (
  season_id text primary key references seasons(id),
  field_size text not null check (field_size in ('46/60','50/70','55/80','60/90')),
  game_minutes integer not null check (game_minutes between 30 and 600),
  buffer_minutes integer not null check (buffer_minutes between 0 and 240),
  regular_games integer not null check (regular_games between 0 and 200),
  exhibition_games integer not null check (exhibition_games between 0 and 200),
  doubleheaders text not null check (doubleheaders in ('never','ifNecessary','allowed')),
  starts_on date not null,
  ends_on date not null,
  blackouts date[] not null default '{}',
  windows jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  constraint season_schedule_settings_dates check (ends_on >= starts_on)
);
create table league_schedule_setups (
  league_id text primary key references leagues(id),
  season_ids text[] not null default '{}',
  field_ids text[] not null default '{}',
  updated_at timestamptz not null default now()
);
`,
  down: `
do $refuse$ begin
  if exists (select 1 from season_team_flags where exhibition)
    or exists (select 1 from season_schedule_settings)
    or exists (select 1 from league_schedule_setups) then
    raise exception 'Seasons have scheduling settings; delete them before rolling this back';
  end if;
end $refuse$;
drop table league_schedule_setups;
drop table season_schedule_settings;
drop table season_team_flags;
`
}
