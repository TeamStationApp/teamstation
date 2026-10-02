import type { Migration } from '../runner'

/**
 * Takes an outside scorekeeping integration out of a database that ran it.
 *
 * Migrations 001–045 build a database that never had it, so on a fresh build
 * this finds nothing and changes nothing. A database with history holds four
 * of its tables, two of its columns on `live_streams`, provenance values that
 * name it, and audit rows about it. Each is found here by what it carries
 * rather than by its name:
 *
 * - its accounts by `pending_state`, its refresh jobs by `cancel_requested`,
 *   its stream targets by `ingest_url_cipher`, and its archive of responses by
 *   `media_type` and `payload`;
 * - the relay pair on `live_streams` as the column with a foreign key to the
 *   stream targets (`X_target_id`) and the boolean beside it (`X_enabled`).
 *
 * A signature that matches two tables stops the migration, because guessing
 * which one to drop is not something to do to a database with history.
 *
 * Audit rows about the dropped tables go with them, found by the entity type
 * of any audit row that names one of their rows, so rows about an entity
 * already deleted go too. The relay switch's key (`XEnabled`) leaves the
 * audit rows of the cameras it was flipped on, and a row with nothing left in
 * it goes.
 *
 * The provenance columns lose the value that named the integration: a column
 * that said where a row came from says `import`, and a play an outside
 * scorer sent says `external`. Each check is dropped, the rows updated and the
 * check added back exactly as the rewritten migrations define it, so this
 * database and a fresh one have the same schema.
 *
 * There is no way back. The dropped rows are in the dump taken before the
 * deploy that runs this.
 */
export const migration046ExternalCleanup: Migration = {
  name: '046externalCleanup',
  up: `
create or replace function pg_temp.gs_table_with(cols text[]) returns regclass
language plpgsql as $fn$
declare
  found regclass[];
begin
  select array_agg(c.oid::regclass order by c.relname) into found
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = current_schema()
    and c.relkind = 'r'
    and (
      select count(*) from pg_attribute a
      where a.attrelid = c.oid
        and not a.attisdropped
        and a.attname = any(cols)
    ) = array_length(cols, 1);
  if found is null then
    return null;
  end if;
  if array_length(found, 1) > 1 then
    raise exception 'More than one table carries %: %', cols, found;
  end if;
  return found[1];
end
$fn$;

do $body$
declare
  accounts regclass := pg_temp.gs_table_with(array['pending_state']);
  jobs regclass := pg_temp.gs_table_with(array['cancel_requested']);
  targets regclass := pg_temp.gs_table_with(array['ingest_url_cipher']);
  archive regclass := pg_temp.gs_table_with(array['media_type', 'payload']);
  owned text[] := '{}';
  part text[];
  types text[];
  target_col text;
  flag_col text;
  flag_key text;
  touched text[];
  tbl regclass;
begin
  -- The rows of the three tables an audit row could name.
  foreach tbl in array array_remove(array[accounts, jobs, targets], null) loop
    execute format('select coalesce(array_agg(id::text), ''{}'') from %s', tbl)
      into part;
    owned := owned || part;
  end loop;
  select coalesce(array_agg(distinct entity_type), '{}') into types
  from audit_log
  where entity_id = any(owned) and entity_type is not null;
  delete from audit_log where entity_type = any(types);

  -- The relay pair on live_streams, and the switch's key in audit rows.
  if targets is not null then
    select a.attname into target_col
    from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    where k.conrelid = 'live_streams'::regclass
      and k.contype = 'f'
      and k.confrelid = targets;
  end if;
  if target_col is not null and target_col like '%\\_target\\_id' then
    flag_col := left(target_col, length(target_col) - length('_target_id'))
      || '_enabled';
    select string_agg(
      case when i = 1 then w else initcap(w) end, '' order by i
    ) into flag_key
    from unnest(string_to_array(flag_col, '_')) with ordinality as t(w, i);

    with stripped as (
      update audit_log
      set before = case when jsonb_typeof(before) = 'object'
            then before - flag_key else before end,
          after = case when jsonb_typeof(after) = 'object'
            then after - flag_key else after end
      where (jsonb_typeof(before) = 'object' and before ? flag_key)
         or (jsonb_typeof(after) = 'object' and after ? flag_key)
      returning id
    )
    select coalesce(array_agg(id), '{}') into touched from stripped;
    delete from audit_log
    where id = any(touched)
      and coalesce(before, '{}'::jsonb) = '{}'::jsonb
      and coalesce(after, '{}'::jsonb) = '{}'::jsonb;

    execute format('alter table live_streams drop column %I', target_col);
    if exists (
      select 1 from pg_attribute
      where attrelid = 'live_streams'::regclass
        and attname = flag_col
        and not attisdropped
        and atttypid = 'boolean'::regtype
    ) then
      execute format('alter table live_streams drop column %I', flag_col);
    end if;
  end if;

  -- The tables themselves, a job before the account it belongs to.
  foreach tbl in array array_remove(
    array[jobs, accounts, targets, archive], null
  ) loop
    execute format('drop table %s', tbl);
  end loop;
end
$body$;

drop function pg_temp.gs_table_with(text[]);

do $body$
declare
  rec record;
  key_name text;
begin
  for rec in
    select * from (values
      ('teams', 'created_from', 'import',
        $$('import', 'peertube', 'manual', 'videoTitle', 'api')$$),
      ('teams', 'logo_source', 'import', $$('import', 'peertube', 'upload')$$),
      ('seasons', 'logo_source', 'import', $$('import', 'peertube', 'upload')$$),
      ('leagues', 'logo_source', 'import', $$('import', 'peertube', 'upload')$$),
      ('users', 'avatar_source', 'import', $$('import', 'peertube', 'upload')$$),
      ('users', 'bats_source', 'import', $$('import', 'manual')$$),
      ('user_emails', 'source', 'import', $$('peertube', 'import', 'manual')$$),
      ('season_members', 'source', 'import',
        $$('peertube', 'import', 'manual')$$),
      ('league_members', 'source', 'import',
        $$('peertube', 'import', 'manual')$$),
      ('events', 'source', 'external',
        $$('external', 'manual', 'gamestation')$$)
    ) as t(tbl, col, value, list)
  loop
    for key_name in
      select k.conname
      from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid
      where k.conrelid = rec.tbl::regclass
        and k.contype = 'c'
        and a.attname = rec.col
        and k.conkey = array[a.attnum]
    loop
      execute format('alter table %I drop constraint %I', rec.tbl, key_name);
    end loop;
    execute format(
      'update %I set %I = %L where %I is not null and %I not in %s',
      rec.tbl, rec.col, rec.value, rec.col, rec.col, rec.list
    );
    execute format(
      'alter table %I add constraint %I check (%I in %s)',
      rec.tbl, rec.tbl || '_' || rec.col || '_check', rec.col, rec.list
    );
  end loop;
end
$body$;

alter table events alter column source set default 'external';

update events set gumbo = gumbo - 'source' where gumbo ? 'source';

delete from schema_migrations where name ~ '^(016|032)';
`,
  // The dropped rows cannot be put back by a migration; the dump taken before
  // the deploy is the way back.
  down: `
select 1;
`
}
