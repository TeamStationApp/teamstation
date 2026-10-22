/** Fixed dependency inventory from the shipped numeric chat schema. */
export const CHAT_ID_TRIGGERS = [
  {
    table_name: 'league_members',
    name: 'chat_dirty_league_members_update',
    definition:
      "CREATE TRIGGER chat_dirty_league_members_update AFTER UPDATE ON @table@ FOR EACH ROW WHEN ((((old.league_id IS DISTINCT FROM new.league_id) OR (old.user_id IS DISTINCT FROM new.user_id)) OR (old.role IS DISTINCT FROM new.role))) EXECUTE FUNCTION chat_dirty_row('league:league_id')"
  },
  {
    table_name: 'memberships',
    name: 'chat_dirty_memberships_update',
    definition:
      "CREATE TRIGGER chat_dirty_memberships_update AFTER UPDATE ON @table@ FOR EACH ROW WHEN (((((old.team_id IS DISTINCT FROM new.team_id) OR (old.user_id IS DISTINCT FROM new.user_id)) OR (old.role IS DISTINCT FROM new.role)) OR (old.is_player IS DISTINCT FROM new.is_player))) EXECUTE FUNCTION chat_dirty_row('team:team_id', 'user:user_id')"
  },
  {
    table_name: 'scope_roles',
    name: 'chat_dirty_scope_roles_update',
    definition:
      'CREATE TRIGGER chat_dirty_scope_roles_update AFTER UPDATE ON @table@ FOR EACH ROW WHEN (((((old.scope_type IS DISTINCT FROM new.scope_type) OR (old.scope_id IS DISTINCT FROM new.scope_id)) OR (old.user_id IS DISTINCT FROM new.user_id)) OR (old.role IS DISTINCT FROM new.role))) EXECUTE FUNCTION chat_dirty_scope_role()'
  },
  {
    table_name: 'season_members',
    name: 'chat_dirty_season_members_update',
    definition:
      "CREATE TRIGGER chat_dirty_season_members_update AFTER UPDATE ON @table@ FOR EACH ROW WHEN ((((old.season_id IS DISTINCT FROM new.season_id) OR (old.user_id IS DISTINCT FROM new.user_id)) OR (old.role IS DISTINCT FROM new.role))) EXECUTE FUNCTION chat_dirty_row('season:season_id')"
  },
  {
    table_name: 'team_follows',
    name: 'chat_dirty_team_follows_update',
    definition:
      "CREATE TRIGGER chat_dirty_team_follows_update AFTER UPDATE ON @table@ FOR EACH ROW WHEN (((old.team_id IS DISTINCT FROM new.team_id) OR (old.user_id IS DISTINCT FROM new.user_id))) EXECUTE FUNCTION chat_dirty_row('team:team_id', 'user:user_id')"
  },
  {
    table_name: 'user_emails',
    name: 'chat_dirty_user_emails_update',
    definition:
      "CREATE TRIGGER chat_dirty_user_emails_update AFTER UPDATE ON @table@ FOR EACH ROW WHEN ((old.user_id IS DISTINCT FROM new.user_id)) EXECUTE FUNCTION chat_dirty_row('user:user_id')"
  },
  {
    table_name: 'user_links',
    name: 'chat_dirty_user_links_update',
    definition:
      "CREATE TRIGGER chat_dirty_user_links_update AFTER UPDATE ON @table@ FOR EACH ROW WHEN ((((old.user_id IS DISTINCT FROM new.user_id) OR (old.related_user_id IS DISTINCT FROM new.related_user_id)) OR (old.kind IS DISTINCT FROM new.kind))) EXECUTE FUNCTION chat_dirty_row('user:user_id', 'user:related_user_id')"
  },
  {
    table_name: 'users',
    name: 'chat_dirty_users_merged',
    definition:
      "CREATE TRIGGER chat_dirty_users_merged AFTER UPDATE ON @table@ FOR EACH ROW WHEN ((old.merged_into IS DISTINCT FROM new.merged_into)) EXECUTE FUNCTION chat_dirty_row('user:id', 'user:merged_into')"
  },
  {
    table_name: 'team_follows',
    name: 'chat_sync_legacy_team_follow_update',
    definition:
      'CREATE TRIGGER chat_sync_legacy_team_follow_update AFTER UPDATE ON @table@ FOR EACH ROW WHEN (((old.user_id IS DISTINCT FROM new.user_id) OR (old.team_id IS DISTINCT FROM new.team_id))) EXECUTE FUNCTION chat_sync_legacy_team_follow()'
  },
  {
    table_name: 'follows',
    name: 'chat_sync_public_team_follow_update',
    definition:
      'CREATE TRIGGER chat_sync_public_team_follow_update AFTER UPDATE ON @table@ FOR EACH ROW WHEN ((((old.user_id IS DISTINCT FROM new.user_id) OR (old.group_type IS DISTINCT FROM new.group_type)) OR (old.group_id IS DISTINCT FROM new.group_id))) EXECUTE FUNCTION chat_sync_public_team_follow()'
  },
  {
    table_name: 'user_emails',
    name: 'user_emails_login_enabled',
    definition:
      'CREATE TRIGGER user_emails_login_enabled AFTER INSERT OR DELETE OR UPDATE OF user_id ON @table@ FOR EACH ROW EXECUTE FUNCTION user_emails_login_enabled()'
  },
  {
    table_name: 'users',
    name: 'users_login_enabled',
    definition:
      'CREATE TRIGGER users_login_enabled BEFORE INSERT OR UPDATE OF password_hash, merged_into, login_enabled ON @table@ FOR EACH ROW EXECUTE FUNCTION users_login_enabled()'
  }
] as const

export const CHAT_ID_KEYS = [
  {
    name: 'chat_epoch_boxes_user_id_identity_id_generation_fkey',
    table_name: 'chat_epoch_boxes',
    definition:
      'FOREIGN KEY (user_id, identity_id, generation) REFERENCES chat_user_keys(user_id, identity_id, generation) ON DELETE CASCADE',
    column_name: 'user_id'
  },
  {
    name: 'chat_epochs_identity_id_created_by_user_id_fkey',
    table_name: 'chat_epochs',
    definition:
      'FOREIGN KEY (identity_id, created_by_user_id) REFERENCES chat_identities(id, user_id)',
    column_name: 'created_by_user_id'
  },
  {
    name: 'chat_grant_requests_user_id_identity_id_generation_fkey',
    table_name: 'chat_grant_requests',
    definition:
      'FOREIGN KEY (user_id, identity_id, generation) REFERENCES chat_user_keys(user_id, identity_id, generation) ON DELETE CASCADE',
    column_name: 'user_id'
  },
  {
    name: 'chat_messages_sender_identity_id_sender_user_id_fkey',
    table_name: 'chat_messages',
    definition:
      'FOREIGN KEY (sender_identity_id, sender_user_id) REFERENCES chat_identities(id, user_id)',
    column_name: 'sender_user_id'
  },
  {
    name: 'chat_user_key_boxes_user_id_identity_id_generation_fkey',
    table_name: 'chat_user_key_boxes',
    definition:
      'FOREIGN KEY (user_id, identity_id, generation) REFERENCES chat_user_keys(user_id, identity_id, generation) ON DELETE CASCADE',
    column_name: 'user_id'
  },
  {
    name: 'chat_user_keys_identity_id_user_id_fkey',
    table_name: 'chat_user_keys',
    definition:
      'FOREIGN KEY (identity_id, user_id) REFERENCES chat_identities(id, user_id) ON DELETE CASCADE',
    column_name: 'user_id'
  }
] as const

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`

/** Fixed catalog data, shared by the pre-cutover validator and finalizer. */
export const chatIdInventorySql = `
create or replace function pg_temp.chat_id_trigger_definition(definition text) returns text
language plpgsql immutable as $normalize$
declare start_at integer; end_at integer; condition text; normalized text;
begin
  start_at := strpos(definition,' FOR EACH ROW WHEN (');
  if start_at=0 then return definition; end if;
  start_at := start_at + length(' FOR EACH ROW WHEN ');
  end_at := strpos(definition,' EXECUTE FUNCTION ');
  if end_at<=start_at then raise exception 'Unexpected identity trigger condition'; end if;
  condition := substring(definition from start_at for end_at-start_at);
  normalized := regexp_replace(condition,'[()]','','g');
  -- Only these literal-free, fixed DISTINCT/OR forms can discard grouping.
  if normalized !~ '^old[.][a-z_]+ IS DISTINCT FROM new[.][a-z_]+( OR old[.][a-z_]+ IS DISTINCT FROM new[.][a-z_]+)*$' then
    raise exception 'Unexpected identity trigger condition';
  end if;
  return substring(definition from 1 for start_at-1) || normalized || substring(definition from end_at);
end $normalize$;
create temp table _chat_expected_id_triggers(table_name name,name name,definition text,
  function_name name,trigger_type smallint,update_columns text[]) on commit drop;
insert into _chat_expected_id_triggers values ${CHAT_ID_TRIGGERS.map(
  t =>
    `(${literal(t.table_name)},${literal(t.name)},${literal(t.definition)},${literal(/EXECUTE FUNCTION ([a-z_]+)\(/.exec(t.definition)![1])},` +
    `${t.name === 'users_login_enabled' ? 23 : t.name === 'user_emails_login_enabled' ? 29 : 17},` +
    `${t.name === 'users_login_enabled' ? "array['password_hash','merged_into','login_enabled']" : t.name === 'user_emails_login_enabled' ? "array['user_id']" : 'array[]::text[]'})`
).join(',')};
create temp table _chat_expected_id_keys(table_name name,name name,definition text,column_name name) on commit drop;
insert into _chat_expected_id_keys values ${CHAT_ID_KEYS.map(
  k =>
    `(${literal(k.table_name)},${literal(k.name)},${literal(k.definition)},${literal(k.column_name)})`
).join(',')};
`

/** Exact definitions include WHEN, UPDATE OF, function, arguments and event timing. */
export const chatIdValidateSql = `
do $validate_chat_ids$
declare expected record; actual text; function_schema name; function_name name;
  trigger_type smallint; update_columns text[]; mode "char";
begin
  for expected in select * from _chat_expected_id_triggers loop
    select replace(pg_get_triggerdef(t.oid),
        format(' ON %I.%I ',current_schema(),expected.table_name),' ON @table@ '),
        n.nspname,p.proname,t.tgtype,t.tgenabled,
        array(select a.attname::text from unnest(t.tgattr::smallint[]) with ordinality cols(attnum,position)
          join pg_attribute a on a.attrelid=t.tgrelid and a.attnum=cols.attnum order by cols.position)
        into actual,function_schema,function_name,trigger_type,mode,update_columns
      from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      join pg_namespace n on n.oid=p.pronamespace
      where t.tgrelid=to_regclass(format('%I.%I',current_schema(),expected.table_name))
        and t.tgname=expected.name and not t.tgisinternal;
    -- PostgreSQL flattens the OR groups when replaying its own deparsed ROW
    -- DISTINCT conditions. These fixed conditions contain only DISTINCT terms
    -- joined by OR: parenthesization cannot change their meaning. Keep every
    -- other token, including timing, UPDATE OF, arguments and function, exact.
    if pg_temp.chat_id_trigger_definition(actual) is distinct from pg_temp.chat_id_trigger_definition(expected.definition)
      or function_schema is distinct from current_schema() or function_name is distinct from expected.function_name
      or trigger_type is distinct from expected.trigger_type or update_columns is distinct from expected.update_columns
      or mode is null or mode not in ('O','D','R','A') then
      raise exception 'Unexpected chat identity trigger: %',expected.name;
    end if;
  end loop;
  for expected in select * from _chat_expected_id_keys loop
    select pg_get_constraintdef(c.oid) into actual from pg_constraint c
      where c.conrelid=to_regclass(format('%I.%I',current_schema(),expected.table_name))
        and c.conname=expected.name and c.contype='f' and c.convalidated;
    if actual is distinct from expected.definition then
      raise exception 'Unexpected chat identity constraint: %',expected.name;
    end if;
  end loop;
end $validate_chat_ids$;
`
