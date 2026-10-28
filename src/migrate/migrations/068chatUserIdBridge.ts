import { chatIdInventorySql, chatIdValidateSql } from '../chatUserIdBridge'
import type { Migration } from '../runner'

/** Quiesced writers remain stopped until 075 restores the composite ownership checks. */
export const migration068ChatUserIdBridge: Migration = {
  name: '068chatUserIdBridge',
  up: `${chatIdInventorySql}${chatIdValidateSql}
do $chat_id_bridge$
declare expected record; identity_type text; blocker text;
begin
  select format_type(atttypid,atttypmod) into identity_type from pg_attribute
    where attrelid='users'::regclass and attname='id' and not attisdropped;
  if identity_type='text' then return; end if;
  if identity_type is distinct from 'bigint' then raise exception 'Unexpected account identity type'; end if;

  create table chat_user_id_bridge_triggers (
    name name primary key,
    table_name name not null,
    definition text not null,
    enabled "char" not null check (enabled in ('O','D','R','A'))
  );
  for expected in select * from _chat_expected_id_triggers loop
    insert into chat_user_id_bridge_triggers
      select t.tgname,expected.table_name,pg_get_triggerdef(t.oid),t.tgenabled
      from pg_trigger t where t.tgrelid=to_regclass(expected.table_name::text) and t.tgname=expected.name;
    execute format('drop trigger %I on %I',expected.name,expected.table_name);
  end loop;
  for expected in select * from _chat_expected_id_keys loop
    -- The validated original constraint proves every existing ownership tuple.
    execute format('alter table %I validate constraint %I',expected.table_name,expected.name);
    execute format('alter table %I drop constraint %I',expected.table_name,expected.name);
    execute format('alter table %I add constraint %I foreign key (%I) references users(id)',
      expected.table_name,'chat_id_bridge_' || expected.table_name,expected.column_name);
  end loop;

  -- 069 discovers the direct user FKs, including the six temporary bridges.
  -- Refuse any unrecognized WHEN or UPDATE OF dependency on those columns.
  with identity_columns as (
    select distinct c.conrelid as tbl,unnest(c.conkey) as col
      from pg_constraint c where c.contype='f' and c.confrelid='users'::regclass
    union select 'users'::regclass,attnum from pg_attribute
      where attrelid='users'::regclass and attname='id'
  )
  select t.tgname into blocker from pg_trigger t
    where not t.tgisinternal and (
      exists(select 1 from pg_depend d join identity_columns i
        on i.tbl=d.refobjid and i.col=d.refobjsubid
        where d.classid='pg_trigger'::regclass and d.objid=t.oid
          and d.refclassid='pg_class'::regclass)
      or exists(select 1 from identity_columns i
        where i.tbl=t.tgrelid and i.col=any(t.tgattr::smallint[]))
    ) limit 1;
  if blocker is not null then raise exception 'Unexpected identity-dependent trigger: %',blocker; end if;
end $chat_id_bridge$;
`,
  down: `do $irreversible$ begin
    raise exception 'Restore the matching pre-cutover backup; the chat identity bridge is completed by 075';
  end $irreversible$;`
}
