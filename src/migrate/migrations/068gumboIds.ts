import type { Migration } from '../runner'

/** Scoring keeps its numeric identity independently of the account's primary key. */
export const migration068GumboIds: Migration = {
  name: '068gumboIds',
  up: `
-- Validate before changing anything, including unvalidated foreign keys.
do $check$
declare broken bigint[]; ref record;
begin
  select array_agg(id order by id) into broken from users
    where id < 1 or id > 9007199254740991;
  if broken is not null then
    raise exception 'Invalid user ids (%): %', cardinality(broken), broken;
  end if;
  for ref in
    select c.conrelid::regclass as relation, a.attname as column_name
    from pg_constraint c join pg_attribute a
      on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
    where c.contype='f' and c.confrelid='users'::regclass
  loop
    execute format('select array_agg(distinct r.%I) from %s r left join users u on u.id=r.%I where r.%I is not null and u.id is null',
      ref.column_name, ref.relation, ref.column_name, ref.column_name) into broken;
    if broken is not null then
      raise exception 'Broken user references in %.% (%): %', ref.relation, ref.column_name, cardinality(broken), broken;
    end if;
  end loop;
end
$check$;

create table gumbo_ids (
  gumbo_id bigint primary key check (gumbo_id between 1 and 9007199254740991),
  user_id bigint not null unique references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
insert into gumbo_ids(gumbo_id,user_id) select id,id from users;

alter table event_players drop constraint event_players_user_id_fkey;
alter table event_players rename column user_id to gumbo_id;
alter table event_players add constraint event_players_gumbo_id_fkey
  foreign key (gumbo_id) references gumbo_ids(gumbo_id) on delete cascade;
alter table game_player_stats drop constraint game_player_stats_user_id_fkey;
alter table game_player_stats rename column user_id to gumbo_id;
alter table game_player_stats add constraint game_player_stats_gumbo_id_fkey
  foreign key (gumbo_id) references gumbo_ids(gumbo_id) on delete cascade;
alter table "eventCredits" drop constraint "eventCredits_creditUserId_fkey";
alter table "eventCredits" rename column "creditUserId" to "creditGumboId";
alter table "eventCredits" add constraint "eventCredits_creditGumboId_fkey"
  foreign key ("creditGumboId") references gumbo_ids(gumbo_id);

-- Keep the trigger's JSON contract and casts; only its destination columns move.
do $children$
begin
  execute replace(replace(pg_get_functiondef('events_sync_children()'::regprocedure),
    'user_id', 'gumbo_id'), '"creditUserId"', '"creditGumboId"');
end
$children$;

create function ts_lineup_gumbo_ids(held jsonb) returns jsonb
language plpgsql immutable as $lineup$
declare result jsonb := held; person jsonb; position text; batters jsonb;
begin
  if held ? 'lineup' then
    result := jsonb_set(result,'{lineup}',ts_lineup_gumbo_ids(held->'lineup'));
  end if;
  if jsonb_typeof(held->'batters')='array' then
    select coalesce(jsonb_agg(case when value ? 'userId'
      then (value-'userId') || jsonb_build_object('gumboId',value->'userId')
      else value end order by ordinal), '[]'::jsonb) into batters
      from jsonb_array_elements(held->'batters') with ordinality as p(value,ordinal);
    result := jsonb_set(result,'{batters}',batters);
  end if;
  if jsonb_typeof(held->'defense')='object' then
    for position,person in select key,value from jsonb_each(held->'defense') loop
      if person ? 'userId' then
        result := jsonb_set(result,array['defense',position],
          (person-'userId') || jsonb_build_object('gumboId',person->'userId'));
      end if;
    end loop;
  end if;
  return result;
end
$lineup$;
update teams set default_lineup=ts_lineup_gumbo_ids(default_lineup)
  where default_lineup is not null;
drop function ts_lineup_gumbo_ids(jsonb);

-- Until selective allocation lands, every new numeric account also gets its
-- existing numeric scoring identity, including writers outside the API.
create function ts_new_user_gumbo_id() returns trigger language plpgsql as $new$
begin
  insert into gumbo_ids(gumbo_id,user_id) values(new.id,new.id);
  return new;
end
$new$;
create trigger users_gumbo_id after insert on users
  for each row execute function ts_new_user_gumbo_id();
`,
  down: `do $restore$ begin
    raise exception 'Restore the pre-cutover database backup and matching code; scoring identity migrations cannot be reversed';
  end $restore$;`
}
