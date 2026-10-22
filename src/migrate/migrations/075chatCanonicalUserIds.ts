import { chatIdInventorySql, chatIdValidateSql } from '../chatUserIdBridge'
import type { Migration } from '../runner'

/** Finish the account cutover without rewriting any encrypted or signed history. */
export const migration075ChatCanonicalUserIds: Migration = {
  name: '075chatCanonicalUserIds',
  up: `${chatIdInventorySql}
create or replace function login_enabled_for(uid text,pw text,merged text) returns boolean
language sql stable as $login$
  select merged is null and (pw is not null or exists(select 1 from user_emails e where e.user_id=uid))
$login$;
create or replace function refresh_login_enabled(uid text) returns void
language sql as $refresh$
  update users u set login_enabled=login_enabled_for(u.id,u.password_hash,u.merged_into)
  where u.id=uid and u.login_enabled is distinct from login_enabled_for(u.id,u.password_hash,u.merged_into)
$refresh$;
create or replace function users_login_enabled() returns trigger language plpgsql as $users$
begin
  new.login_enabled := login_enabled_for(new.id,new.password_hash,new.merged_into);
  return new;
end $users$;
create or replace function user_emails_login_enabled() returns trigger language plpgsql as $emails$
begin
  if tg_op <> 'DELETE' then perform refresh_login_enabled(new.user_id); end if;
  if tg_op <> 'INSERT' then perform refresh_login_enabled(old.user_id); end if;
  return null;
end $emails$;

do $restore_chat_ids$
declare expected record; saved record; actual text; enabled_sql text; n integer;
begin
  if not exists(select 1 from pg_attribute where attrelid='users'::regclass
    and attname='id' and atttypid='text'::regtype and not attisdropped) then
    raise exception 'Canonical account cutover has not completed';
  end if;
  if to_regclass('chat_user_id_bridge_triggers') is not null then
    select count(*) into n from chat_user_id_bridge_triggers;
    if n<>12 then raise exception 'Incomplete chat identity trigger bridge'; end if;
    for saved in select * from chat_user_id_bridge_triggers loop
      select * into expected from _chat_expected_id_triggers where name=saved.name and table_name=saved.table_name;
      actual := replace(saved.definition,format(' ON %I.%I ',current_schema(),saved.table_name),' ON @table@ ');
      if not found or pg_temp.chat_id_trigger_definition(actual)
        is distinct from pg_temp.chat_id_trigger_definition(expected.definition) then
        raise exception 'Unexpected saved identity trigger: %',saved.name;
      end if;
      execute saved.definition;
      enabled_sql := case saved.enabled when 'O' then 'enable' when 'D' then 'disable'
        when 'R' then 'enable replica' when 'A' then 'enable always' else null end;
      if enabled_sql is null then raise exception 'Unexpected saved trigger mode'; end if;
      execute format('alter table %I %s trigger %I',saved.table_name,enabled_sql,saved.name);
    end loop;
    for expected in select * from _chat_expected_id_keys loop
      select pg_get_constraintdef(c.oid) into actual from pg_constraint c
        where c.conrelid=to_regclass(expected.table_name::text)
          and c.conname='chat_id_bridge_' || expected.table_name;
      if actual is distinct from format('FOREIGN KEY (%I) REFERENCES users(id)',expected.column_name) then
        raise exception 'Unexpected temporary identity constraint: %',expected.table_name;
      end if;
      execute format('alter table %I add constraint %I %s',expected.table_name,expected.name,expected.definition);
      execute format('alter table %I drop constraint %I',expected.table_name,'chat_id_bridge_' || expected.table_name);
    end loop;
    drop table chat_user_id_bridge_triggers;
  end if;
end $restore_chat_ids$;
${chatIdValidateSql}

drop function if exists refresh_login_enabled(bigint);
drop function if exists login_enabled_for(bigint,text,bigint);

insert into chat_dirty(scope_type,scope_id,marked_at)
  select 'user',ts_user_id_of_gumbo(scope_id::bigint),marked_at from chat_dirty
  where scope_type='user' and scope_id ~ '^[1-9][0-9]{0,15}$'
    and scope_id::numeric<=9007199254740991
  on conflict(scope_type,scope_id) do update set marked_at=greatest(chat_dirty.marked_at,excluded.marked_at);
delete from chat_dirty where scope_type='user' and scope_id ~ '^[1-9][0-9]{0,15}$'
  and scope_id::numeric<=9007199254740991;
do $validate_marks$ begin
  if exists(select 1 from chat_dirty where scope_type='user' and not ts_is_user_id(scope_id)) then
    raise exception 'Invalid live chat identity mark';
  end if;
end $validate_marks$;
`,
  down: `do $irreversible$ begin
    raise exception 'Restore the matching pre-cutover backup; canonical chat identities cannot be reversed';
  end $irreversible$;`
}
