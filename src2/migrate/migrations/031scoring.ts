import type { Migration } from '../runner'

/**
 * One Gumbo play per events row.
 *
 * User ids become the leading 53 bits of the old `usr_` string, stored as
 * bigint, with the original string kept on `users.legacyId`. Event score
 * fields become generated columns of `gumbo`. Credits move into the document,
 * each naming its person by `creditUserId` alone, and a trigger copies them
 * out to `eventCredits` whenever the document is written. `games.scoringOwner`
 * is set once GameStation scores a game itself, after which another service
 * may no longer replace its plays.
 */
export const migration031Scoring: Migration = {
  name: '031scoring',
  up: `
create extension if not exists pgcrypto;

create or replace function gs_user_id_number(id text) returns bigint
language plpgsql immutable as $fn$
declare
  raw bytea;
  n bigint := 0;
  i int;
begin
  if id is null then
    return null;
  end if;
  if id !~ '^usr_[A-Za-z0-9_-]{16}$' then
    raise exception
      'user id is not usr_ plus 16 base64url characters: %', id;
  end if;
  raw := decode(translate(substr(id, 5), '-_', '+/'), 'base64');
  for i in 0..6 loop
    n := (n << 8) | get_byte(raw, i);
  end loop;
  return n >> 3;
end
$fn$;

create or replace function gs_make_id(prefix text) returns text
language sql volatile as $fn$
  select prefix || '_' || rtrim(
    translate(encode(gen_random_bytes(12), 'base64'), '+/', '-_'),
    '='
  );
$fn$;

do $body$
begin
  if exists (
    select 1 from users
    where id !~ '^usr_[A-Za-z0-9_-]{16}$'
  ) then
    raise exception 'users.id is not usr_ plus 16 base64url characters';
  end if;
  if exists (
    select 1 from users
    group by gs_user_id_number(id)
    having count(*) > 1
  ) then
    raise exception 'two users share a userIdNumber';
  end if;
end
$body$;

alter table users add column "legacyId" text;
update users set "legacyId" = id;
alter table users alter column "legacyId" set not null;
alter table users add constraint users_legacy_id_key unique ("legacyId");

create temp table _gs_user_cols (
  tbl regclass,
  colname name,
  primary key (tbl, colname)
) on commit drop;

insert into _gs_user_cols (tbl, colname)
select distinct c.conrelid, a.attname
from pg_constraint c
join pg_attribute a
  on a.attrelid = c.conrelid
 and a.attnum = any (c.conkey)
 and not a.attisdropped
where c.confrelid = 'public.users'::regclass
  and c.contype = 'f';

do $body$
declare
  rec record;
  restores text[] := '{}';
  stmt text;
begin
  for rec in
    select c.conname, c.conrelid::regclass as tbl,
           pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.confrelid = 'public.users'::regclass
      and c.contype = 'f'
  loop
    restores := array_append(restores, format(
      'alter table %s add constraint %I %s',
      rec.tbl, rec.conname, rec.def
    ));
    execute format(
      'alter table %s drop constraint %I',
      rec.tbl, rec.conname
    );
  end loop;

  -- One statement per table, so a check that compares two user columns
  -- (user_links.user_id <> related_user_id) is not evaluated halfway.
  for rec in select distinct tbl from _gs_user_cols loop
    select string_agg(format(
      'alter column %I type bigint using gs_user_id_number(%I::text)',
      colname, colname
    ), ', ') into stmt
    from _gs_user_cols
    where tbl = rec.tbl;
    execute format('alter table %s %s', rec.tbl, stmt);
  end loop;

  alter table users
    alter column id type bigint using gs_user_id_number(id);
  alter table users
    add constraint users_id_safe check (id between 0 and 9007199254740991);

  foreach stmt in array restores loop
    execute stmt;
  end loop;
end
$body$;

-- Only the kinds that name a person hold a user id in entity_id. Every
-- other kind holds a team, game, season or organisation id, which keeps its
-- string form. The pattern leaves alone a row that holds anything else.
update external_ids
set entity_id = gs_user_id_number(entity_id)::text
where kind in ('player', 'user', 'account')
  and entity_id ~ '^usr_[A-Za-z0-9_-]{16}$';

-- A lineScore row is what the season importer stored for a game it held
-- nothing but a line score for: no play, only the two totals. It becomes
-- a final_score play, so that game's score comes from its plays like every
-- other game's.
update events
set gumbo = jsonb_build_object(
  'about', jsonb_build_object(
    'atBatIndex', at_bat_index,
    'isScoringPlay', is_scoring_play
  ),
  'result', jsonb_build_object(
    'eventType', 'final_score',
    'awayScore', gumbo->'away',
    'homeScore', gumbo->'home',
    'description', to_jsonb(description)
  )
)
where gumbo->>'source' = 'lineScore';

-- A score correction settles the score after everything else in the game,
-- and a game's score is read off its plays in index order. So each correction
-- moves to just past the game's highest ordinary index, in id order, which
-- also takes it off any index a play already holds before
-- events_game_atbat makes an index unique.
with next as (
  select e.id,
         coalesce((
           select max(o.at_bat_index)
           from events o
           where o.game_id = e.game_id
             and o.id <> e.id
             and o.event_type is distinct from 'score_correction'
             and o.gumbo #>> '{result,eventType}' is distinct from 'score_correction'
         ), -1) + row_number() over (partition by e.game_id order by e.id) as at_bat
  from events e
  where e.event_type = 'score_correction'
     or e.gumbo #>> '{result,eventType}' = 'score_correction'
)
update events e
set at_bat_index = next.at_bat,
    gumbo = jsonb_set(
      case
        when jsonb_typeof(e.gumbo->'about') = 'object' then e.gumbo
        else jsonb_set(e.gumbo, '{about}', '{}'::jsonb, true)
      end,
      '{about,atBatIndex}',
      to_jsonb(next.at_bat),
      true
    )
from next
where e.id = next.id;

update events
set gumbo = jsonb_set(
  case
    when jsonb_typeof(gumbo->'about') = 'object' then gumbo
    else jsonb_set(gumbo, '{about}', '{}'::jsonb, true)
  end,
  '{about,atBatIndex}',
  to_jsonb(at_bat_index),
  true
)
where gumbo #>> '{about,atBatIndex}' is null;

update events
set gumbo = jsonb_set(
  case
    when jsonb_typeof(gumbo->'about') = 'object' then gumbo
    else jsonb_set(gumbo, '{about}', '{}'::jsonb, true)
  end,
  '{about,isScoringPlay}',
  to_jsonb(is_scoring_play),
  true
);

update events
set gumbo = jsonb_set(gumbo, '{result,description}', to_jsonb(description), true)
where description is not null;

update events
set gumbo = jsonb_set(
  case
    when jsonb_typeof(gumbo->'about') = 'object' then gumbo
    else jsonb_set(gumbo, '{about}', '{}'::jsonb, true)
  end,
  '{about,startTime}',
  to_jsonb(start_time),
  true
)
where start_time is not null;

update events
set gumbo = jsonb_set(
  case
    when jsonb_typeof(gumbo->'about') = 'object' then gumbo
    else jsonb_set(gumbo, '{about}', '{}'::jsonb, true)
  end,
  '{about,endTime}',
  to_jsonb(end_time),
  true
)
where end_time is not null;

-- A credit names its person by user id alone. One that named nobody by a
-- GameStation id keeps its name only.
update events e
set gumbo = jsonb_set(
  e.gumbo,
  '{credits}',
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'eventType', c->>'eventType',
        'label', c->>'label',
        'teamId', c->>'teamId',
        'creditUserId',
          (select u.id from users u where u."legacyId" = c->>'creditUserId'),
        'credit', jsonb_build_object(
          'name', coalesce(c #>> '{credit,name}', ''),
          'role', c #>> '{credit,role}',
          'position', c #>> '{credit,position}'
        )
      )
      order by ord
    )
    from jsonb_array_elements(e.credits) with ordinality as t(c, ord)
  ), '[]'::jsonb),
  true
)
where jsonb_typeof(e.credits) = 'array';

alter table events
  add column "creditsLookedAt" boolean not null default false;
update events
set "creditsLookedAt" = coalesce(jsonb_typeof(credits) = 'array', false);

create table "eventCredits" (
  id text primary key,
  "eventId" text not null references events (id) on delete cascade,
  "eventType" text not null,
  label text not null,
  "teamId" text,
  "creditUserId" bigint references users (id),
  name text not null default '',
  role text,
  position text
);

insert into "eventCredits" (
  id, "eventId", "eventType", label, "teamId", "creditUserId",
  name, role, position
)
select
  gs_make_id('evc'),
  e.id,
  coalesce(c->>'eventType', ''),
  coalesce(c->>'label', ''),
  c->>'teamId',
  case
    when jsonb_typeof(c->'creditUserId') = 'number'
      then (c->>'creditUserId')::bigint
    else null
  end,
  coalesce(c #>> '{credit,name}', ''),
  c #>> '{credit,role}',
  c #>> '{credit,position}'
from events e
cross join lateral jsonb_array_elements(e.gumbo->'credits') as c
where jsonb_typeof(e.gumbo->'credits') = 'array';

create index event_credits_user on "eventCredits" ("creditUserId");
create index event_credits_event on "eventCredits" ("eventId");

drop index if exists events_credits;
alter table events drop column if exists credits;

do $body$
declare
  rec record;
begin
  for rec in
    select conname
    from pg_constraint
    where conrelid = 'events'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%at_bat_index%'
  loop
    execute format('alter table events drop constraint %I', rec.conname);
  end loop;
end
$body$;

drop index if exists events_game_order;
drop index if exists events_scoring;

alter table events
  drop column at_bat_index,
  drop column inning,
  drop column half_inning,
  drop column event_type,
  drop column description,
  drop column is_scoring_play,
  drop column rbi,
  drop column away_score,
  drop column home_score;

alter table events rename column game_id to "gameId";
alter table events rename column start_time to "startTime";
alter table events rename column end_time to "endTime";
alter table events rename column batting_team_id to "battingTeamId";
alter table events rename column title_override to "titleOverride";
alter table events rename column time_nudge_sec to "timeNudgeSec";
alter table events rename column created_at to "createdAt";
alter table events rename column updated_at to "updatedAt";

do $body$
declare
  rec record;
begin
  for rec in
    select conname
    from pg_constraint
    where conrelid = 'events'::regclass
      and contype = 'c'
      and conkey = array[(
        select attnum from pg_attribute
        where attrelid = 'events'::regclass and attname = 'source'
      )]
  loop
    execute format('alter table events drop constraint %I', rec.conname);
  end loop;
end
$body$;

alter table events add constraint events_source_check
  check (source in ('external', 'manual', 'gamestation'));

alter table events
  add column "atBatIndex" integer
    generated always as (((gumbo #>> '{about,atBatIndex}')::integer)) stored not null,
  add column "eventType" text
    generated always as ((gumbo #>> '{result,eventType}')) stored,
  add column "isScoringPlay" boolean
    generated always as (((gumbo #>> '{about,isScoringPlay}')::boolean)) stored,
  add column inning integer
    generated always as (((gumbo #>> '{about,inning}')::integer)) virtual,
  add column "halfInning" text
    generated always as ((gumbo #>> '{about,halfInning}')) virtual,
  add column description text
    generated always as ((gumbo #>> '{result,description}')) virtual,
  add column rbi integer
    generated always as (((gumbo #>> '{result,rbi}')::integer)) virtual,
  add column "awayScore" integer
    generated always as (((gumbo #>> '{result,awayScore}')::integer)) virtual,
  add column "homeScore" integer
    generated always as (((gumbo #>> '{result,homeScore}')::integer)) virtual;

-- The index behind events_game_atbat also serves reading a game's plays in
-- order, so events_game_order, on the same two columns, is not made again.
alter table events
  add constraint events_game_atbat unique ("gameId", "atBatIndex");
create index events_scoring on events ("gameId") where "isScoringPlay";

alter table games add column "scoringOwner" text;

create or replace function events_set_credits_looked_at()
returns trigger language plpgsql as $fn$
begin
  new."creditsLookedAt" :=
    coalesce(jsonb_typeof(new.gumbo -> 'credits') = 'array', false);
  return new;
end
$fn$;

create trigger events_credits_looked_at_trg
before insert or update of gumbo on events
for each row execute function events_set_credits_looked_at();

-- The stored document is the only copy of a play a client writes, and
-- "eventCredits" and the batter, pitcher and runner rows of event_players are
-- read from it. This keeps them in step by deleting and inserting them again
-- when the document is written: a play has a handful of each, and they carry
-- nothing the document does not, so nothing is lost. The trigger fires only
-- when gumbo or "battingTeamId" is written, so hiding a play or nudging its
-- time leaves its rows and their ids alone. The credits are rebuilt on each
-- of those writes. The batter, pitcher and runner rows are rebuilt only when
-- the document has a matchup, runners or play events, because a document
-- with none of them, such as a line-score-only play or one stored before
-- plays carried players, says nothing about who played, and rows written for
-- it some other way stay. The fielder, catcher and scorer rows, which people
-- add by hand, are never touched.
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

create trigger events_sync_children_trg
after insert or update of gumbo, "battingTeamId" on events
for each row execute function events_sync_children();
`,
  down: `
drop trigger if exists events_sync_children_trg on events;
drop trigger if exists events_credits_looked_at_trg on events;
drop function if exists events_sync_children();
drop function if exists events_set_credits_looked_at();

drop table if exists "eventCredits";

alter table events drop constraint if exists events_game_atbat;
drop index if exists events_scoring;

alter table events
  drop column if exists "atBatIndex",
  drop column if exists "eventType",
  drop column if exists "isScoringPlay",
  drop column if exists inning,
  drop column if exists "halfInning",
  drop column if exists description,
  drop column if exists rbi,
  drop column if exists "awayScore",
  drop column if exists "homeScore";

alter table events
  add column at_bat_index integer,
  add column inning integer,
  add column half_inning text,
  add column event_type text,
  add column description text,
  add column is_scoring_play boolean not null default false,
  add column rbi integer not null default 0,
  add column away_score integer,
  add column home_score integer;

update events set
  at_bat_index = (gumbo #>> '{about,atBatIndex}')::integer,
  inning = (gumbo #>> '{about,inning}')::integer,
  half_inning = gumbo #>> '{about,halfInning}',
  event_type = gumbo #>> '{result,eventType}',
  description = gumbo #>> '{result,description}',
  is_scoring_play = coalesce((gumbo #>> '{about,isScoringPlay}')::boolean, false),
  rbi = coalesce((gumbo #>> '{result,rbi}')::integer, 0),
  away_score = (gumbo #>> '{result,awayScore}')::integer,
  home_score = (gumbo #>> '{result,homeScore}')::integer;

alter table events alter column at_bat_index set not null;
alter table events drop constraint if exists events_half_inning_check;
alter table events add constraint events_half_inning_check
  check (half_inning in ('top', 'bottom'));

alter table events rename column "gameId" to game_id;
alter table events rename column "startTime" to start_time;
alter table events rename column "endTime" to end_time;
alter table events rename column "battingTeamId" to batting_team_id;
alter table events rename column "titleOverride" to title_override;
alter table events rename column "timeNudgeSec" to time_nudge_sec;
alter table events rename column "createdAt" to created_at;
alter table events rename column "updatedAt" to updated_at;

alter table events
  add constraint events_game_id_at_bat_index_key unique (game_id, at_bat_index);
create index events_game_order on events (game_id, at_bat_index);
create index events_scoring on events (game_id) where is_scoring_play;

alter table events drop constraint if exists events_source_check;
alter table events add constraint events_source_check
  check (source in ('external', 'manual'));

alter table events drop column if exists "creditsLookedAt";
alter table games drop column if exists "scoringOwner";

update external_ids e
set entity_id = u."legacyId"
from users u
where e.kind in ('player', 'user', 'account')
  and e.entity_id = u.id::text;

alter table users drop constraint if exists users_id_safe;

-- Read from a copy, not from users: users.merged_into is itself a user
-- column, and a function that reads users while users is being rewritten
-- fails on the first row.
create temp table _gs_legacy_ids on commit drop as
select id, "legacyId" from users;
create unique index on _gs_legacy_ids (id);

create or replace function gs_legacy_id(user_id bigint) returns text
language sql stable as $fn$
  select "legacyId" from _gs_legacy_ids where id = user_id;
$fn$;

create temp table _gs_user_cols_down (
  tbl regclass,
  colname name,
  primary key (tbl, colname)
) on commit drop;

insert into _gs_user_cols_down (tbl, colname)
select distinct c.conrelid, a.attname
from pg_constraint c
join pg_attribute a
  on a.attrelid = c.conrelid
 and a.attnum = any (c.conkey)
 and not a.attisdropped
where c.confrelid = 'public.users'::regclass
  and c.contype = 'f';

do $body$
declare
  rec record;
  restores text[] := '{}';
  stmt text;
begin
  for rec in
    select c.conname, c.conrelid::regclass as tbl,
           pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.confrelid = 'public.users'::regclass
      and c.contype = 'f'
  loop
    restores := array_append(restores, format(
      'alter table %s add constraint %I %s',
      rec.tbl, rec.conname, rec.def
    ));
    execute format(
      'alter table %s drop constraint %I',
      rec.tbl, rec.conname
    );
  end loop;

  for rec in select distinct tbl from _gs_user_cols_down loop
    select string_agg(format(
      'alter column %I type text using gs_legacy_id(%I)',
      colname, colname
    ), ', ') into stmt
    from _gs_user_cols_down
    where tbl = rec.tbl;
    execute format('alter table %s %s', rec.tbl, stmt);
  end loop;

  alter table users alter column id type text using "legacyId";

  foreach stmt in array restores loop
    execute stmt;
  end loop;
end
$body$;

-- The credits list goes back on its own column, with each user named by the
-- string id it had then, and with the index the player page searched it by.
alter table events add column credits jsonb;
update events e
set credits = coalesce((
  select jsonb_agg(
    case
      when jsonb_typeof(t.c->'creditUserId') = 'number' then jsonb_set(
        t.c,
        '{creditUserId}',
        coalesce(
          to_jsonb(gs_legacy_id((t.c->>'creditUserId')::bigint)),
          'null'::jsonb
        )
      )
      else t.c
    end
    order by ord
  )
  from jsonb_array_elements(e.gumbo->'credits') with ordinality as t(c, ord)
), '[]'::jsonb)
where jsonb_typeof(e.gumbo->'credits') = 'array';
create index events_credits on events using gin (credits jsonb_path_ops);

alter table users drop constraint if exists users_legacy_id_key;
alter table users drop column if exists "legacyId";

drop function if exists gs_legacy_id(bigint);
drop function if exists gs_make_id(text);
drop function if exists gs_user_id_number(text);
`
}
