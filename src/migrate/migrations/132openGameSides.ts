import type { Migration } from '../runner'

/**
 * A game's side may be open: a null `home_team_id` or `away_team_id` is a
 * team not known yet, named TBD in every answer (`common/openSides.ts`). The
 * foreign keys and the `games_home_team` and `games_away_team` indexes stay.
 *
 * The `offlineSet` notice of `games_user_notices` (migration 130) names only
 * the named teams. The other database code that reads a game's teams needs no
 * change: the scoring and statistics trigger functions (031, 037, 091) run on
 * `events` rows, which a game has only after its open sides are filled;
 * `games_withdrawn_by_team_check` (050) passes for a null side;
 * `games_live_changes` (111) compares rows with `is distinct from`; and
 * `game_play_archives` (084) and `schedule_preview_games` (080) are written
 * only for games whose sides are named.
 *
 * Going down refuses while any game has an open side.
 */
export const migration132OpenGameSides: Migration = {
  name: '132openGameSides',
  up: `
alter table games alter column home_team_id drop not null;
alter table games alter column away_team_id drop not null;

create or replace function games_user_notices() returns trigger
language plpgsql as $$
declare
  teams text[] := array[]::text[];
begin
  if tg_op <> 'INSERT' then
    teams := teams || array[old.home_team_id::text, old.away_team_id::text];
  end if;
  if tg_op <> 'DELETE' then
    teams := teams || array[new.home_team_id::text, new.away_team_id::text];
  end if;
  perform pg_notify('user_notices', json_build_object(
    't', 'offlineSet', 'g', coalesce(
      (select array_agg(distinct one) from unnest(array_remove(teams, null)) one),
      array[]::text[])
  )::text);
  return null;
end
$$;
`,
  down: `
do $$
begin
  if exists (
    select 1 from games where home_team_id is null or away_team_id is null
  ) then
    raise exception 'Games with an open side remain';
  end if;
end
$$;

alter table games alter column home_team_id set not null;
alter table games alter column away_team_id set not null;

create or replace function games_user_notices() returns trigger
language plpgsql as $$
declare
  teams text[] := array[]::text[];
begin
  if tg_op <> 'INSERT' then
    teams := teams || array[old.home_team_id::text, old.away_team_id::text];
  end if;
  if tg_op <> 'DELETE' then
    teams := teams || array[new.home_team_id::text, new.away_team_id::text];
  end if;
  perform pg_notify('user_notices', json_build_object(
    't', 'offlineSet', 'g', (select array_agg(distinct one) from unnest(teams) one)
  )::text);
  return null;
end
$$;
`
}
