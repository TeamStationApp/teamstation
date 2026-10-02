import type { Migration } from '../runner'

/**
 * Accounts, guardians, birth months and the SafeSport setting.
 *
 * **`login_enabled` means "has a way to sign in".** It is true exactly when
 * the user is unmerged and has an address on `user_emails` (a sign-in code
 * or link reaches them) or a `password_hash`. Every user is recomputed here,
 * and triggers keep it so from now on: `refresh_login_enabled(user)` runs
 * after a row of `user_emails` is added, removed or moved to another user,
 * and a `users` row has it worked out before it is written, on insert and on
 * any change to `password_hash`, `merged_into` or `login_enabled` itself. So
 * a script or a route that writes `login_enabled` directly cannot leave it
 * disagreeing with the sign-ins the user actually has. A future way to sign
 * in adds its table to `login_enabled_for` and gets triggers of its own.
 *
 * **Guardian invites.** `invites.guardian_of_user_id` names the player an
 * invitation makes its redeemer a guardian (or, by `relative_kind`, an adult
 * family member) of. Both are set together, and only on a team invite.
 *
 * **Birth months, never birthdays.** `users.birth_year` and
 * `users.birth_month`, both or neither. No column holds a day of birth.
 *
 * **`leagues.safesport_lao`**: the league is a SafeSport Local Affiliated
 * Organization, which binds it to the MAAPP.
 *
 * Down drops all of it; `login_enabled` keeps the values it had.
 */
export const migration051GuardiansAndAccounts: Migration = {
  name: '051guardiansAndAccounts',
  up: `
alter table invites
  add column guardian_of_user_id bigint references users (id),
  add column relative_kind text
    check (relative_kind in ('guardian', 'family')),
  add constraint invites_guardian_of_team check (
    (guardian_of_user_id is null and relative_kind is null) or
    (guardian_of_user_id is not null and relative_kind is not null
      and scope_type = 'team')
  );

alter table users
  add column birth_year smallint,
  add column birth_month smallint check (birth_month between 1 and 12),
  add constraint users_birth_month_both
    check ((birth_year is null) = (birth_month is null));

alter table leagues
  add column safesport_lao boolean not null default false;

create function login_enabled_for(uid bigint, pw text, merged bigint)
returns boolean
language sql stable as $$
  select merged is null and (
    pw is not null or
    exists (select 1 from user_emails e where e.user_id = uid)
  )
$$;

create function refresh_login_enabled(uid bigint) returns void
language sql as $$
  update users u
  set login_enabled = login_enabled_for(u.id, u.password_hash, u.merged_into)
  where u.id = uid
    and u.login_enabled is distinct from
      login_enabled_for(u.id, u.password_hash, u.merged_into)
$$;

create function users_login_enabled() returns trigger
language plpgsql as $$
begin
  new.login_enabled := login_enabled_for(new.id, new.password_hash, new.merged_into);
  return new;
end
$$;

create trigger users_login_enabled
  before insert or update of password_hash, merged_into, login_enabled
  on users
  for each row execute function users_login_enabled();

create function user_emails_login_enabled() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'DELETE' then
    perform refresh_login_enabled(new.user_id);
  end if;
  if tg_op <> 'INSERT' then
    perform refresh_login_enabled(old.user_id);
  end if;
  return null;
end
$$;

create trigger user_emails_login_enabled
  after insert or delete or update of user_id
  on user_emails
  for each row execute function user_emails_login_enabled();

update users
set login_enabled = login_enabled_for(id, password_hash, merged_into)
where login_enabled is distinct from
  login_enabled_for(id, password_hash, merged_into);
`,
  down: `
drop trigger user_emails_login_enabled on user_emails;
drop function user_emails_login_enabled();
drop trigger users_login_enabled on users;
drop function users_login_enabled();
drop function refresh_login_enabled(bigint);
drop function login_enabled_for(bigint, text, bigint);
alter table leagues drop column safesport_lao;
alter table users
  drop constraint users_birth_month_both,
  drop column birth_month,
  drop column birth_year;
alter table invites
  drop constraint invites_guardian_of_team,
  drop column relative_kind,
  drop column guardian_of_user_id;
`
}
