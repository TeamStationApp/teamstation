import type { Migration } from '../runner'

/**
 * Tells every API worker, when its transaction commits and never when it
 * rolls back, what a signed-in person's screens should read again, whoever
 * wrote it.
 *
 * On `user_notices`, as `{"t": <topic>, …}`:
 * - The bell (`"t": "badge"`). A notice recorded for people (a device asking
 *   to be approved records one), a receipt, a role or a membership name
 *   their people (`"u"`), at most 100 a notice. A device's approval or
 *   refusal reaches its person as chat's own `link` hint. A request, or one of its sides, names the
 *   scopes its sides ask (`"s"`, `[kind, id]` pairs) and its sender (`"u"`);
 *   the workers tell whoever sees those scopes.
 * - The games a phone keeps to score (`"t": "offlineSet"`). A role or a
 *   membership names its person (`"u"`). A game created, deleted, moved,
 *   rescheduled, cancelled, finished or given its first score names its
 *   teams (`"g"`), and so does a team joining or leaving a season or a
 *   league (`"g"`, with `"l": true`: roles carried down may have moved).
 *
 * On `game_changes`, to the games of the team: a membership's change as
 * `{"team": <id>, "kind": "roster"}`, and a team's default lineup's as
 * `{"team": <id>, "kind": "defaultLineup"}`.
 *
 * An update names its columns twice, in `update of` and in `when`, so a
 * write that sets a column to the value it had says nothing.
 */
export const migration130RefreshNotices: Migration = {
  name: '130refreshNotices',
  up: `
create function notify_users(topic text, users text[]) returns void
language plpgsql as $$
declare
  first int := 1;
begin
  if users is null or cardinality(users) = 0 then
    return;
  end if;
  while first <= cardinality(users) loop
    perform pg_notify(
      'user_notices',
      json_build_object('t', topic, 'u', users[first:first + 99])::text
    );
    first := first + 100;
  end loop;
end
$$;

create function notification_events_user_notices() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    perform notify_users('badge', old.recorded_recipients);
  end if;
  if tg_op <> 'DELETE' then
    perform notify_users('badge', new.recorded_recipients);
  end if;
  return null;
end
$$;

create trigger notification_events_user_notices
after insert or update or delete on notification_events
for each row execute function notification_events_user_notices();

create function user_id_badge_notices() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    perform notify_users('badge', array[old.user_id::text]);
  end if;
  if tg_op <> 'DELETE' then
    perform notify_users('badge', array[new.user_id::text]);
  end if;
  return null;
end
$$;

create trigger notification_receipts_user_notices
after insert or update or delete on notification_receipts
for each row execute function user_id_badge_notices();

create function user_id_role_notices() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    perform notify_users('badge', array[old.user_id::text]);
    perform notify_users('offlineSet', array[old.user_id::text]);
  end if;
  if tg_op <> 'DELETE' then
    perform notify_users('badge', array[new.user_id::text]);
    perform notify_users('offlineSet', array[new.user_id::text]);
  end if;
  return null;
end
$$;

create trigger scope_roles_user_notices
after insert or update or delete on scope_roles
for each row execute function user_id_role_notices();

create trigger memberships_user_notices
after insert or update or delete on memberships
for each row execute function user_id_role_notices();

create function request_badge_notice(request text) returns void
language plpgsql as $$
begin
  perform pg_notify('user_notices', json_build_object(
    't', 'badge',
    'r', request,
    'u', (select coalesce(array_agg(sender_id::text), array[]::text[])
            from group_requests where id = request),
    's', (select coalesce(json_agg(json_build_array(scope_type, scope_id)),
                          '[]'::json)
            from group_request_sides where request_id = request)
  )::text);
end
$$;

create function group_requests_user_notices() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform pg_notify('user_notices', json_build_object(
      't', 'badge', 'u', array[old.sender_id::text]
    )::text);
  else
    perform request_badge_notice(new.id);
  end if;
  return null;
end
$$;

create trigger group_requests_user_notices
after insert or update or delete on group_requests
for each row execute function group_requests_user_notices();

create function group_request_sides_user_notices() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    perform pg_notify('user_notices', json_build_object(
      't', 'badge', 's', json_build_array(
        json_build_array(old.scope_type, old.scope_id))
    )::text);
  end if;
  if tg_op <> 'DELETE' then
    perform request_badge_notice(new.request_id);
  end if;
  return null;
end
$$;

create trigger group_request_sides_user_notices
after insert or update or delete on group_request_sides
for each row execute function group_request_sides_user_notices();

create function games_user_notices() returns trigger
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

create trigger games_user_notices
after insert or delete on games
for each row execute function games_user_notices();

-- What makes a game one a phone may score (offlineManifest's scoringEntry):
-- its time, status and teams, whether it has scores or a linescore, who
-- keeps its score, and whether its current play is TeamStation's.
create trigger games_user_notices_update
after update of start_at, status, home_team_id, away_team_id,
  cancellation_reason, season_id, home_score, away_score, linescore,
  "scoringOwner", "currentPlay" on games
for each row
when (
  (old.start_at, old.status, old.home_team_id, old.away_team_id,
   old.cancellation_reason, old.season_id,
   old.home_score is null, old.away_score is null, old.linescore is null,
   old."scoringOwner", coalesce(old."currentPlay" ? 'teamStation', false))
  is distinct from
  (new.start_at, new.status, new.home_team_id, new.away_team_id,
   new.cancellation_reason, new.season_id,
   new.home_score is null, new.away_score is null, new.linescore is null,
   new."scoringOwner", coalesce(new."currentPlay" ? 'teamStation', false))
)
execute function games_user_notices();

create function team_links_user_notices() returns trigger
language plpgsql as $$
declare
  team text;
begin
  if tg_op = 'DELETE' then
    team := old.team_id;
  else
    team := new.team_id;
  end if;
  perform pg_notify('user_notices', json_build_object(
    't', 'offlineSet', 'g', array[team], 'l', true
  )::text);
  return null;
end
$$;

create trigger season_teams_user_notices
after insert or update or delete on season_teams
for each row execute function team_links_user_notices();

create trigger season_team_parents_user_notices
after insert or update or delete on season_team_parents
for each row execute function team_links_user_notices();

create function teams_league_user_notices() returns trigger
language plpgsql as $$
begin
  perform pg_notify('user_notices', json_build_object(
    't', 'offlineSet', 'g', array[new.id::text], 'l', true
  )::text);
  return null;
end
$$;

create trigger teams_league_user_notices
after update of league_id on teams
for each row
when (old.league_id is distinct from new.league_id)
execute function teams_league_user_notices();

create function memberships_roster_changes() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    perform pg_notify('game_changes', json_build_object(
      'team', old.team_id, 'kind', 'roster')::text);
  end if;
  if tg_op <> 'DELETE' then
    perform pg_notify('game_changes', json_build_object(
      'team', new.team_id, 'kind', 'roster')::text);
  end if;
  return null;
end
$$;

create trigger memberships_roster_changes
after insert or update or delete on memberships
for each row execute function memberships_roster_changes();

create function teams_default_lineup_changes() returns trigger
language plpgsql as $$
begin
  perform pg_notify('game_changes', json_build_object(
    'team', new.id, 'kind', 'defaultLineup')::text);
  return null;
end
$$;

create trigger teams_default_lineup_changes
after update of default_lineup on teams
for each row
when (old.default_lineup is distinct from new.default_lineup)
execute function teams_default_lineup_changes();
`,
  down: `
drop trigger teams_default_lineup_changes on teams;
drop function teams_default_lineup_changes();
drop trigger memberships_roster_changes on memberships;
drop function memberships_roster_changes();
drop trigger teams_league_user_notices on teams;
drop function teams_league_user_notices();
drop trigger season_team_parents_user_notices on season_team_parents;
drop trigger season_teams_user_notices on season_teams;
drop function team_links_user_notices();
drop trigger games_user_notices_update on games;
drop trigger games_user_notices on games;
drop function games_user_notices();
drop trigger group_request_sides_user_notices on group_request_sides;
drop function group_request_sides_user_notices();
drop trigger group_requests_user_notices on group_requests;
drop function group_requests_user_notices();
drop function request_badge_notice(text);
drop trigger memberships_user_notices on memberships;
drop trigger scope_roles_user_notices on scope_roles;
drop function user_id_role_notices();
drop trigger notification_receipts_user_notices on notification_receipts;
drop function user_id_badge_notices();
drop trigger notification_events_user_notices on notification_events;
drop function notification_events_user_notices();
drop function notify_users(text, text[]);
`
}
