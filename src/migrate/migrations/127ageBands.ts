import type { Migration } from '../runner'

/**
 * Every account's age band (`ageBandOf` in `common/age.ts`) comes from its
 * birth month or, without one, from `is_adult`: a person who said they are
 * 18 or older and gave no month. `age_source` says who set the age most
 * recently, and `age_set_at` when the person first gave it themselves (by
 * hand or through Apple's age range); it stays once a guardian or a site
 * administrator changes the age later.
 *
 * `is_adult` changes a person's band, so it re-checks their chats like a
 * birth month does.
 */
export const migration127AgeBands: Migration = {
  name: '127ageBands',
  up: `
alter table users
  add column is_adult boolean not null default false,
  add column age_source text
    check (age_source in ('self', 'apple', 'guardian', 'admin')),
  add column age_set_at timestamptz;

drop trigger if exists chat_dirty_users_account on users;
create trigger chat_dirty_users_account after update on users
  for each row
  when ((old.login_enabled, old.birth_year, old.birth_month, old.is_adult)
    is distinct from (new.login_enabled, new.birth_year, new.birth_month, new.is_adult))
  execute function chat_dirty_row('user:id');
`,
  down: `
drop trigger if exists chat_dirty_users_account on users;
create trigger chat_dirty_users_account after update on users
  for each row
  when ((old.login_enabled, old.birth_year, old.birth_month)
    is distinct from (new.login_enabled, new.birth_year, new.birth_month))
  execute function chat_dirty_row('user:id');

alter table users
  drop column age_set_at,
  drop column age_source,
  drop column is_adult;
`
}
