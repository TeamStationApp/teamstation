import type { Migration } from '../runner'

/**
 * Keep the deployed chat follow rows and the newer public follow API in step.
 * Both tables and their migration names stay: existing chat audiences continue
 * to read team_follows, while public league/season follows remain independent.
 * Disabling an account also asks chat to reconcile its current memberships.
 */
export const migration057ChatMasterCompatibility: Migration = {
  name: '057chatMasterCompatibility',
  up: `
insert into follows (user_id, group_type, group_id, created_at)
select user_id, 'team', team_id, created_at from team_follows
on conflict (user_id, group_type, group_id) do nothing;

insert into team_follows (user_id, team_id, created_at)
select f.user_id, f.group_id, f.created_at from follows f
join teams t on t.id = f.group_id
where f.group_type = 'team'
on conflict (user_id, team_id) do nothing;

create function chat_sync_public_team_follow() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    if old.group_type = 'team' then
      delete from team_follows
      where user_id = old.user_id and team_id = old.group_id;
    end if;
  end if;
  if tg_op <> 'DELETE' then
    if new.group_type = 'team' and exists (select 1 from teams where id = new.group_id) then
      insert into team_follows (user_id, team_id, created_at)
      values (new.user_id, new.group_id, new.created_at)
      on conflict (user_id, team_id) do nothing;
    end if;
  end if;
  return null;
end $$;

create function chat_sync_legacy_team_follow() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    delete from follows
    where user_id = old.user_id and group_type = 'team' and group_id = old.team_id;
  end if;
  if tg_op <> 'DELETE' then
    insert into follows (user_id, group_type, group_id, created_at)
    values (new.user_id, 'team', new.team_id, new.created_at)
    on conflict (user_id, group_type, group_id) do nothing;
  end if;
  return null;
end $$;

create trigger chat_sync_public_team_follow after insert or delete on follows
  for each row execute function chat_sync_public_team_follow();
create trigger chat_sync_public_team_follow_update after update on follows
  for each row when ((old.user_id, old.group_type, old.group_id)
    is distinct from (new.user_id, new.group_type, new.group_id))
  execute function chat_sync_public_team_follow();
create trigger chat_sync_legacy_team_follow after insert or delete on team_follows
  for each row execute function chat_sync_legacy_team_follow();
create trigger chat_sync_legacy_team_follow_update after update on team_follows
  for each row when ((old.user_id, old.team_id) is distinct from (new.user_id, new.team_id))
  execute function chat_sync_legacy_team_follow();

create trigger chat_dirty_users_disabled after update on users
  for each row when (old.disabled_at is distinct from new.disabled_at)
  execute function chat_dirty_row('user:id');

select chat_mark_dirty('user', id::text) from users where disabled_at is not null;
`,
  down: `
drop trigger chat_dirty_users_disabled on users;
drop trigger chat_sync_legacy_team_follow_update on team_follows;
drop trigger chat_sync_legacy_team_follow on team_follows;
drop trigger chat_sync_public_team_follow_update on follows;
drop trigger chat_sync_public_team_follow on follows;
drop function chat_sync_legacy_team_follow();
drop function chat_sync_public_team_follow();
`
}
