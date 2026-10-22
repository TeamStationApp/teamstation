import type { Migration } from '../runner'

/**
 * The Auto-Scheduler's previews. A preview is one build of a league's
 * schedule: the input the engine ran on, up to three options, and the edits
 * made to one of them. Publishing an option proposes its games, and each
 * proposed game keeps a `schedule_preview_games` row, so a retry skips what
 * was already proposed, and a game that is declined, rained out or rejected
 * later can be listed for rescheduling. `games.schedule_preview_id` names
 * the preview a game was published from.
 */
export const migration080SchedulePreviews: Migration = {
  name: '080schedulePreviews',
  up: `
create table schedule_previews (
  id text primary key,
  league_id text not null references leagues(id),
  created_by text not null references users(id),
  created_at timestamptz not null default now(),
  mode text not null check (mode in ('full','partial')),
  input jsonb not null,
  options jsonb not null default '[]',
  blocking text,
  edits jsonb not null default '{}',
  status text not null default 'open'
    check (status in ('open','published','discarded')),
  published_option integer,
  published_at timestamptz,
  removed_games integer,
  constraint schedule_previews_published
    check ((status = 'published') = (published_at is not null))
);
create index schedule_previews_league on schedule_previews(league_id, created_at);
create table schedule_preview_games (
  preview_id text not null references schedule_previews(id),
  game_key text not null,
  season_id text not null references seasons(id),
  home_team_id text not null references teams(id),
  away_team_id text not null references teams(id),
  request_id text references group_requests(id),
  game_id text references games(id) on delete set null,
  rejected_at timestamptz,
  resolved_at timestamptz,
  primary key (preview_id, game_key)
);
create index schedule_preview_games_game on schedule_preview_games(game_id)
  where game_id is not null;
create index schedule_preview_games_request on schedule_preview_games(request_id)
  where request_id is not null;
alter table games add column schedule_preview_id text references schedule_previews(id);
`,
  down: `
do $refuse$ begin
  if exists (select 1 from schedule_previews) then
    raise exception 'Schedules have been previewed; delete the previews before rolling this back';
  end if;
end $refuse$;
alter table games drop column schedule_preview_id;
drop table schedule_preview_games;
drop table schedule_previews;
`
}
