import type { Migration } from '../runner'

/**
 * `login_enabled` is the account's own switch again, and the triggers from
 * 051guardiansAndAccounts (redefined in 075chatCanonicalUserIds) only ever
 * turn it off, when an account loses its last way to sign in: its password
 * cleared, or its last address removed or moved to somebody else, with
 * neither left. They no longer turn it on when an address or a password
 * arrives, nor overrule a value an update writes, and they take no notice of
 * a merge: a merge closes the row (`merged_into`), and undoing it gives the
 * row back as it was.
 *
 * So an account is made before its address and switched on once it has
 * settled; an administrator or a test can switch an account off that still
 * has an address; and a row that never had a way in cannot keep one it was
 * never given. Nothing already stored is recomputed: what 051 wrote stands.
 *
 * Down puts back 075's derived definitions.
 */
export const migration087LoginOffOnly: Migration = {
  name: '087loginOffOnly',
  up: `
create or replace function refresh_login_enabled(uid text) returns void
language sql as $refresh$
  update users u set login_enabled = false
  where u.id = uid and u.login_enabled and u.password_hash is null
    and not exists (select 1 from user_emails e where e.user_id = uid)
$refresh$;
create or replace function users_login_enabled() returns trigger language plpgsql as $users$
begin
  if tg_op = 'UPDATE' and old.password_hash is not null
    and new.password_hash is null
    and not exists (select 1 from user_emails e where e.user_id = new.id) then
    new.login_enabled := false;
  end if;
  return new;
end $users$;
`,
  down: `
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
`
}
