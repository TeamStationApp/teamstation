import type { Migration } from '../runner'

/**
 * Per-game stats build queue, and a batter is not their own runner.
 *
 * `game_stats_state` is one row per game that has had plays written: the
 * generation asked for, the one built, the status and its reason, and the
 * retry clock. The events write path asks; the stats builder records the
 * result. The migration adds no rows — a game whose plays were written
 * before this keeps its `game_player_stats` until something asks for it.
 *
 * The same change replaces `events_sync_children` so its runner loop skips
 * every runner entry whose id is the play's batter. Those entries are the
 * batter's own trips, and a batter who reaches and then takes another base
 * on the same play has two of them. The batter already has the `batter`
 * row, so `event_players` gets no `runner` row for them. The down path
 * restores 031's body.
 */
export const migration037GameStatsState: Migration = {
  name: '037gameStatsState',
  up: `
create table game_stats_state (
  game_id text primary key references games (id) on delete cascade,
  requested_generation bigint not null,
  built_generation bigint not null default 0,
  status text not null check (status in ('pending', 'built', 'incomplete', 'failed')),
  detail text,
  attempts integer not null default 0,
  retry_at timestamptz,
  requested_at timestamptz not null default now(),
  built_at timestamptz
);
create index game_stats_state_owed on game_stats_state (requested_at)
  where requested_generation > built_generation;

create or replace function events_sync_children()
returns trigger language plpgsql as $fn$
declare
  credit jsonb;
  runner jsonb;
  runner_id bigint;
  home_id text;
  away_id text;
  pitcher_team text;
begin
  delete from "eventCredits" where "eventId" = new.id;
  if jsonb_typeof(new.gumbo -> 'credits') = 'array' then
    for credit in
      select value from jsonb_array_elements(new.gumbo -> 'credits')
    loop
      insert into "eventCredits" (
        id, "eventId", "eventType", label, "teamId", "creditUserId",
        name, role, position
      ) values (
        gs_make_id('evc'),
        new.id,
        coalesce(credit->>'eventType', ''),
        coalesce(credit->>'label', ''),
        credit->>'teamId',
        case
          when jsonb_typeof(credit->'creditUserId') = 'number'
            then (credit->>'creditUserId')::bigint
          else null
        end,
        coalesce(credit #>> '{credit,name}', ''),
        credit #>> '{credit,role}',
        credit #>> '{credit,position}'
      );
    end loop;
  end if;

  if new.gumbo ? 'matchup'
     or new.gumbo ? 'runners'
     or new.gumbo ? 'playEvents' then
    delete from event_players
    where event_id = new.id
      and role in ('batter', 'pitcher', 'runner');

    if jsonb_typeof(new.gumbo #> '{matchup,batter,id}') = 'number'
       and (new.gumbo #>> '{matchup,batter,id}') ~ '^[0-9]+$' then
      insert into event_players (id, event_id, user_id, team_id, role)
      values (
        gs_make_id('evp'),
        new.id,
        (new.gumbo #>> '{matchup,batter,id}')::bigint,
        new."battingTeamId",
        'batter'
      );
    end if;

    select g.home_team_id, g.away_team_id into home_id, away_id
    from games g
    where g.id = new."gameId";

    pitcher_team := case
      when new."battingTeamId" is null then null
      when new."battingTeamId" = home_id then away_id
      when new."battingTeamId" = away_id then home_id
      else null
    end;

    if jsonb_typeof(new.gumbo #> '{matchup,pitcher,id}') = 'number'
       and (new.gumbo #>> '{matchup,pitcher,id}') ~ '^[0-9]+$' then
      insert into event_players (id, event_id, user_id, team_id, role)
      values (
        gs_make_id('evp'),
        new.id,
        (new.gumbo #>> '{matchup,pitcher,id}')::bigint,
        pitcher_team,
        'pitcher'
      );
    end if;

    if jsonb_typeof(new.gumbo -> 'runners') = 'array' then
      for runner in
        select value from jsonb_array_elements(new.gumbo -> 'runners')
      loop
        if jsonb_typeof(runner #> '{details,runner,id}') = 'number'
           and (runner #>> '{details,runner,id}') ~ '^[0-9]+$' then
          runner_id := (runner #>> '{details,runner,id}')::bigint;
          if jsonb_typeof(new.gumbo #> '{matchup,batter,id}') = 'number'
             and (new.gumbo #>> '{matchup,batter,id}') ~ '^[0-9]+$'
             and runner_id = (new.gumbo #>> '{matchup,batter,id}')::bigint then
            continue;
          end if;
          if not exists (
            select 1 from event_players
            where event_id = new.id
              and user_id = runner_id
              and role = 'runner'
          ) then
            insert into event_players (id, event_id, user_id, team_id, role)
            values (
              gs_make_id('evp'),
              new.id,
              runner_id,
              new."battingTeamId",
              'runner'
            );
          end if;
        end if;
      end loop;
    end if;
  end if;
  return null;
end
$fn$;
`,
  down: `
drop index if exists game_stats_state_owed;
drop table if exists game_stats_state;

create or replace function events_sync_children()
returns trigger language plpgsql as $fn$
declare
  credit jsonb;
  runner jsonb;
  runner_id bigint;
  home_id text;
  away_id text;
  pitcher_team text;
begin
  delete from "eventCredits" where "eventId" = new.id;
  if jsonb_typeof(new.gumbo -> 'credits') = 'array' then
    for credit in
      select value from jsonb_array_elements(new.gumbo -> 'credits')
    loop
      insert into "eventCredits" (
        id, "eventId", "eventType", label, "teamId", "creditUserId",
        name, role, position
      ) values (
        gs_make_id('evc'),
        new.id,
        coalesce(credit->>'eventType', ''),
        coalesce(credit->>'label', ''),
        credit->>'teamId',
        case
          when jsonb_typeof(credit->'creditUserId') = 'number'
            then (credit->>'creditUserId')::bigint
          else null
        end,
        coalesce(credit #>> '{credit,name}', ''),
        credit #>> '{credit,role}',
        credit #>> '{credit,position}'
      );
    end loop;
  end if;

  if new.gumbo ? 'matchup'
     or new.gumbo ? 'runners'
     or new.gumbo ? 'playEvents' then
    delete from event_players
    where event_id = new.id
      and role in ('batter', 'pitcher', 'runner');

    if jsonb_typeof(new.gumbo #> '{matchup,batter,id}') = 'number'
       and (new.gumbo #>> '{matchup,batter,id}') ~ '^[0-9]+$' then
      insert into event_players (id, event_id, user_id, team_id, role)
      values (
        gs_make_id('evp'),
        new.id,
        (new.gumbo #>> '{matchup,batter,id}')::bigint,
        new."battingTeamId",
        'batter'
      );
    end if;

    select g.home_team_id, g.away_team_id into home_id, away_id
    from games g
    where g.id = new."gameId";

    pitcher_team := case
      when new."battingTeamId" is null then null
      when new."battingTeamId" = home_id then away_id
      when new."battingTeamId" = away_id then home_id
      else null
    end;

    if jsonb_typeof(new.gumbo #> '{matchup,pitcher,id}') = 'number'
       and (new.gumbo #>> '{matchup,pitcher,id}') ~ '^[0-9]+$' then
      insert into event_players (id, event_id, user_id, team_id, role)
      values (
        gs_make_id('evp'),
        new.id,
        (new.gumbo #>> '{matchup,pitcher,id}')::bigint,
        pitcher_team,
        'pitcher'
      );
    end if;

    if jsonb_typeof(new.gumbo -> 'runners') = 'array' then
      for runner in
        select value from jsonb_array_elements(new.gumbo -> 'runners')
      loop
        if jsonb_typeof(runner #> '{details,runner,id}') = 'number'
           and (runner #>> '{details,runner,id}') ~ '^[0-9]+$' then
          runner_id := (runner #>> '{details,runner,id}')::bigint;
          if not exists (
            select 1 from event_players
            where event_id = new.id
              and user_id = runner_id
              and role = 'runner'
          ) then
            insert into event_players (id, event_id, user_id, team_id, role)
            values (
              gs_make_id('evp'),
              new.id,
              runner_id,
              new."battingTeamId",
              'runner'
            );
          end if;
        end if;
      end loop;
    end if;
  end if;
  return null;
end
$fn$;
`
}
