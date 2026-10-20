import type { Migration } from '../runner'

/** Account identities become canonical 128-bit strings; scoring remains numeric. */
export const migration069UserIds: Migration = {
  name: '069userIds',
  up: `
create function ts_user_id_of_gumbo(value bigint) returns text
language plpgsql immutable as $encode$
declare alphabet constant text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; digits text := ''; remaining bigint := value;
begin
  if value is null or value < 1 or value > 9007199254740991 then
    raise exception 'Expected a positive safe-integer gumbo id' using errcode='22023';
  end if;
  while remaining > 0 loop
    digits := substr(alphabet,(remaining % 58)::int+1,1) || digits;
    remaining := remaining / 58;
  end loop;
  return 'usr_' || lpad(digits,22,'1');
end
$encode$;

create function ts_is_user_id(value text) returns boolean
language plpgsql immutable as $validate$
declare alphabet constant text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; decoded numeric := 0; remaining numeric; digits text := ''; i int;
begin
  if value is null or length(value) <> 26 or value !~ '^usr_[1-9A-HJ-NP-Za-km-z]{22}$' then return false; end if;
  for i in 5..26 loop
    decoded := decoded * 58 + strpos(alphabet,substr(value,i,1))-1;
  end loop;
  if decoded < 1 or decoded > 340282366920938463463374607431768211455 then return false; end if;
  remaining := decoded;
  while remaining > 0 loop
    digits := substr(alphabet,mod(remaining,58)::int+1,1) || digits;
    remaining := div(remaining,58);
  end loop;
  return value = 'usr_' || lpad(digits,22,'1');
end
$validate$;

create temp table _ts_user_ids(old bigint primary key,new text not null unique,"legacyId" text) on commit drop;
insert into _ts_user_ids select id,ts_user_id_of_gumbo(id),"legacyId" from users;
do $verify$ begin
  if exists(select 1 from _ts_user_ids where not ts_is_user_id(new)) then
    raise exception 'Invalid derived user identity';
  end if;
end $verify$;

create function pg_temp.ts_mapped_user(value bigint) returns text language plpgsql stable as $map$
declare mapped text;
begin
  if value is null then return null; end if;
  select new into mapped from _ts_user_ids where old=value;
  if mapped is null then raise exception 'Unmapped user identity: %',value using errcode='23503'; end if;
  return mapped;
end $map$;

create temp table _ts_user_columns(tbl regclass,colname name,primary key(tbl,colname)) on commit drop;
insert into _ts_user_columns
select distinct c.conrelid,a.attname from pg_constraint c
join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
where c.contype='f' and c.confrelid='users'::regclass;
insert into _ts_user_columns values('users'::regclass,'id') on conflict do nothing;

drop trigger users_gumbo_id on users;
drop function ts_new_user_gumbo_id();
alter table users drop constraint users_id_safe;
alter table users alter column "legacyId" drop not null;
do $columns$
declare ref record; restores text[] := '{}'; statement text;
begin
  for ref in select conname,conrelid::regclass as tbl,pg_get_constraintdef(oid) as definition
    from pg_constraint where contype='f' and confrelid='users'::regclass
  loop
    restores := array_append(restores,format('alter table %s add constraint %I %s',ref.tbl,ref.conname,ref.definition));
    execute format('alter table %s drop constraint %I',ref.tbl,ref.conname);
  end loop;
  for ref in select distinct tbl from _ts_user_columns loop
    select string_agg(format('alter column %I type text using pg_temp.ts_mapped_user(%I)',colname,colname),', ') into statement
      from _ts_user_columns where tbl=ref.tbl;
    execute format('alter table %s %s',ref.tbl,statement);
  end loop;
  alter table users add constraint users_id_format check(ts_is_user_id(id));
  foreach statement in array restores loop execute statement; end loop;
end $columns$;

create function pg_temp.ts_mapped_users(held_values bigint[]) returns text[] language sql stable as $array$
  select case when held_values is null then null else coalesce(array_agg(pg_temp.ts_mapped_user(value) order by ordinal),'{}'::text[]) end
  from unnest(held_values) with ordinality as ids(value,ordinal)
$array$;
alter table notification_events alter column recorded_recipients type text[] using pg_temp.ts_mapped_users(recorded_recipients);
update external_ids e set entity_id=m.new from _ts_user_ids m
where e.entity_type='user' and (e.entity_id=m.old::text or e.entity_id=m."legacyId");
update group_request_sides s set scope_id=m.new from _ts_user_ids m
where s.scope_type='user' and s.scope_id=m.old::text;

do $terms$
declare row record; key text; changed jsonb; mapped text;
begin
  for row in select id,terms from group_requests loop
    changed := row.terms;
    foreach key in array array['userId','recipientUserId','playerUserId','hostingAuthorizerUserId'] loop
      if jsonb_typeof(changed->key)='number' then
        mapped := pg_temp.ts_mapped_user((changed->>key)::bigint);
        changed := jsonb_set(changed,array[key],to_jsonb(mapped));
      end if;
    end loop;
    if jsonb_typeof(changed#>'{guardian,userId}')='number' then
      mapped := pg_temp.ts_mapped_user((changed#>>'{guardian,userId}')::bigint);
      changed := jsonb_set(changed,'{guardian,userId}',to_jsonb(mapped));
    end if;
    if changed is distinct from row.terms then update group_requests set terms=changed where id=row.id; end if;
  end loop;
end $terms$;

create function ts_ensure_gumbo_id(target text, draws bigint[] default null) returns bigint
language plpgsql volatile as $allocate$
declare held bigint; candidate bigint; bytes bytea; attempt int; i int; violated text;
begin
  perform 1 from users where id=target for update;
  if not found then raise exception 'Unknown user identity: %',target using errcode='23503'; end if;
  select gumbo_id into held from gumbo_ids where user_id=target;
  if held is not null then return held; end if;
  for attempt in 1..5 loop
    if draws is not null then candidate := draws[attempt];
    else
      bytes := gen_random_bytes(7); candidate := 0;
      for i in 0..6 loop candidate := (candidate << 8) | get_byte(bytes,i); end loop;
      candidate := candidate >> 3;
    end if;
    if candidate is null or candidate < 1 or candidate > 9007199254740991 then continue; end if;
    begin
      insert into gumbo_ids(gumbo_id,user_id) values(candidate,target);
      return candidate;
    exception when unique_violation then
      get stacked diagnostics violated = constraint_name;
      if violated = 'gumbo_ids_user_id_key' then
        select gumbo_id into held from gumbo_ids where user_id=target;
        if held is not null then return held; end if;
      elsif violated <> 'gumbo_ids_pkey' then raise;
      end if;
    end;
  end loop;
  raise exception 'Five scoring identity allocations exhausted' using errcode='TSG01';
end $allocate$;
`,
  down: `do $restore$ begin
    raise exception 'Restore the pre-cutover database backup and matching code; user identity migrations cannot be reversed';
  end $restore$;`
}
