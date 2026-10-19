import type { Migration } from '../runner'

/** Only the historical identity map and player identity change; Gumbo stays intact. */
const rewrite = `
create or replace function pg_temp.ts_guest_setup(setup jsonb, game text, restoring boolean)
returns jsonb language plpgsql as $fn$
declare guest record; sid text; held jsonb;
begin
  if setup is null then return null; end if;
  for guest in select * from game_placeholder_guests where game_id = game loop
    sid := guest.session_id::text;
    held := setup #> array['identities', 'sessionToSource', sid];
    if restoring then
      if held <> to_jsonb(guest.user_id) then
        raise exception 'Historical guest identity changed';
      end if;
      if setup #> array['players',sid] is null then
        setup := setup #- array['identities','sessionToSource',sid];
      else
        setup := jsonb_set(setup, array['identities','sessionToSource',sid], 'null');
      end if;
      setup := setup #- array['identities','sourceToSession','number:' || guest.user_id::text];
      setup := jsonb_set(setup, array['players',sid,'userId'], 'null');
    elsif held is null or held = 'null'::jsonb then
      setup := jsonb_set(setup, array['identities','sessionToSource',sid], to_jsonb(guest.user_id));
      setup := jsonb_set(setup, array['identities','sourceToSession','number:' || guest.user_id::text], to_jsonb(guest.session_id));
      setup := jsonb_set(setup, array['players',sid,'userId'], to_jsonb(guest.user_id));
    elsif held <> to_jsonb(guest.user_id) then
      raise exception 'Historical guest session identity is ambiguous';
    end if;
  end loop;
  return setup;
end $fn$;

create or replace function pg_temp.ts_guest_document(doc jsonb, game text, restoring boolean)
returns jsonb language plpgsql as $fn$
declare action jsonb; actions jsonb := '[]';
begin
  if doc #>> '{teamStation,version}' is distinct from '1' then return doc; end if;
  doc := jsonb_set(doc, '{teamStation,setupBefore}',
    pg_temp.ts_guest_setup(doc #> '{teamStation,setupBefore}', game, restoring));
  for action in select value from jsonb_array_elements(doc #> '{teamStation,actions}') loop
    if action ? 'setup' then
      action := jsonb_set(action, '{setup}', pg_temp.ts_guest_setup(action->'setup',game,restoring));
    end if;
    actions := actions || jsonb_build_array(action);
  end loop;
  return jsonb_set(doc,'{teamStation,actions}',actions);
end $fn$;
`

export const migration066GameGuests: Migration = {
  name: '066gameGuests',
  up: `
alter table games add column guests jsonb not null default '{"away":[],"home":[]}';
create table game_placeholder_guests (
  game_id text not null references games(id) on delete cascade,
  session_id bigint not null,
  user_id bigint not null references users(id),
  side text not null check (side in ('away','home')),
  primary key (game_id, session_id),
  unique (user_id)
);
${rewrite}
-- An addPlayer action can be the only surviving description of a guest.
create or replace function pg_temp.ts_guest_setups(doc jsonb) returns setof jsonb
language plpgsql as $fn$
declare setup jsonb; action jsonb; sid bigint; side_name text;
begin
  if doc #>> '{teamStation,version}' is distinct from '1' then return; end if;
  setup := doc #> '{teamStation,setupBefore}';
  return next setup;
  for action in select value from jsonb_array_elements(doc #> '{teamStation,actions}') loop
    if action ? 'setup' then setup := action->'setup';
    elsif action->>'type' = 'lineup' and action->>'kind' = 'addPlayer' then
      sid := (setup #>> '{identities,nextId}')::bigint;
      while (setup #> '{identities,sessionToSource}') ? sid::text loop sid := sid+1; end loop;
      side_name := action->>'side';
      if side_name not in ('away','home') or side_name is null then
        raise exception 'Historical guest has no side';
      end if;
      setup := jsonb_set(setup,array['players',sid::text],jsonb_build_object(
        'id',sid,'userId',null,'fullName',coalesce(action->>'name','New Player')));
      setup := jsonb_set(setup,array['identities','sessionToSource',sid::text],'null');
      setup := jsonb_set(setup,'{identities,nextId}',to_jsonb(sid+1));
      setup := jsonb_set(setup,array['sides',side_name,'players'],
        (setup #> array['sides',side_name,'players'])||to_jsonb(sid));
    else continue;
    end if;
    return next setup;
  end loop;
end $fn$;
do $body$
declare item record; prior record; player jsonb; legacy text; uid bigint; side_name text;
begin
  for item in
    with documents as (
      select "gameId" as game_id, gumbo as doc from events
      union all select id, "currentPlay" from games where "currentPlay" is not null
    ), setups as (
      select game_id, setup from documents
      cross join lateral pg_temp.ts_guest_setups(doc) setup
    )
    select game_id, setup, identity.key as sid from setups
    cross join lateral jsonb_each(setup #> '{identities,sessionToSource}') identity
    where identity.value = 'null'::jsonb
    order by game_id, identity.key
  loop
    player := item.setup #> array['players',item.sid];
    if player is null or item.sid !~ '^[0-9]+$' then
      raise exception 'Invalid historical guest player';
    end if;
    select min(side), count(*) into side_name, uid from (
      select side from (values ('away'),('home')) sides(side)
      where (item.setup #> array['sides',side,'players']) @> to_jsonb(item.sid::bigint)
    ) found;
    if uid <> 1 then raise exception 'Historical guest must belong to one side'; end if;
    select * into prior from game_placeholder_guests
      where game_id=item.game_id and session_id=item.sid::bigint;
    if found then
      if prior.side <> side_name then raise exception 'Historical guest changes sides'; end if;
      continue;
    end if;
    loop
      legacy := ts_make_id('usr'); uid := ts_user_id_number(legacy);
      if uid <= 0 then continue; end if;
      begin
        insert into users (id,"legacyId",display_name,first_name,last_name,login_enabled)
        values (uid,legacy,player->>'fullName',
          coalesce(player->>'firstName',split_part(player->>'fullName',' ',1)),
          coalesce(player->>'lastName',nullif(regexp_replace(player->>'fullName','^[^ ]+ *',''),'')),false);
        exit;
      exception when unique_violation then null;
      end;
    end loop;
    insert into game_placeholder_guests values(item.game_id,item.sid::bigint,uid,side_name);
    update games set guests=jsonb_set(guests,array[side_name],(guests->side_name)||to_jsonb(uid))
      where id=item.game_id;
  end loop;
end $body$;
-- The Gumbo payload is unchanged, so keep the derived row identities as well.
alter table events disable trigger events_sync_children_trg;
update events set gumbo=pg_temp.ts_guest_document(gumbo,"gameId",false)
  where "gameId" in (select game_id from game_placeholder_guests)
    and gumbo #>> '{teamStation,version}' = '1';
alter table events enable trigger events_sync_children_trg;
update games set "currentPlay"=pg_temp.ts_guest_document("currentPlay",id,false)
  where id in (select game_id from game_placeholder_guests) and "currentPlay" is not null;
`,
  down: `
${rewrite}
alter table events disable trigger events_sync_children_trg;
update events set gumbo=pg_temp.ts_guest_document(gumbo,"gameId",true)
  where "gameId" in (select game_id from game_placeholder_guests)
    and gumbo #>> '{teamStation,version}' = '1';
alter table events enable trigger events_sync_children_trg;
update games set "currentPlay"=pg_temp.ts_guest_document("currentPlay",id,true)
  where id in (select game_id from game_placeholder_guests) and "currentPlay" is not null;
create temporary table _guest_users on commit drop as select user_id from game_placeholder_guests;
drop table game_placeholder_guests;
delete from users where id in (select user_id from _guest_users);
alter table games drop column guests;
`
}
