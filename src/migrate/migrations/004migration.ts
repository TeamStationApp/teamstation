import type { Migration } from '../runner'

/**
 * What the PeerTube and team-history import needs that the first three did
 * not.
 *
 * Three changes, each with a reason that came from the real data:
 *
 * 1. **E-mail moves off the user.** One person holds several addresses —
 *    `paul@vtex.net` and `paul@edge.app` are the same person in PeerTube, and
 *    an import knows him by a third. The identity is `users.id`; an address
 *    is an attribute of it. The address is unique across the table, not per
 *    user, because a code sent to it must reach exactly one account.
 *
 * 2. **`merged_into`**, because a person arrives twice and the two are joined
 *    by a human afterwards. The absorbed row is closed, never deleted, so a
 *    merge can be read back.
 *
 * 3. **External teams.** Half the Hawks' recorded games are against teams
 *    no league record names (Mid City, Sunshine). They play
 *    games in a season without being in it, so they are a `teams` row with
 *    `kind = 'external'` and no `season_teams` row.
 */
export const migration004Migration: Migration = {
  name: '004migration',
  up: `
-- 1. Addresses ------------------------------------------------------------
create table user_emails (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  email text not null,
  is_primary boolean not null default false,
  verified_at timestamptz,
  source text not null default 'manual'
    check (source in ('peertube', 'import', 'manual')),
  created_at timestamptz not null default now()
);
-- One address belongs to one account, or a sign-in code is ambiguous.
create unique index user_emails_address on user_emails (lower(email));
create index user_emails_user on user_emails (user_id);
-- At most one primary per user.
create unique index user_emails_one_primary on user_emails (user_id)
  where is_primary;

-- Carry the existing addresses over before the column goes.
insert into user_emails (id, user_id, email, is_primary, source, created_at)
select
  'uem_' || replace(u.id, 'usr_', ''),
  u.id,
  u.email,
  true,
  'manual',
  u.created_at
from users u
where u.email is not null;

drop index if exists users_email_key;
alter table users drop column email;

-- 2. Merging --------------------------------------------------------------
alter table users add column merged_into text references users (id);
create index users_merged_into on users (merged_into) where merged_into is not null;

-- 3. External teams -------------------------------------------------------
alter table teams add column kind text not null default 'full'
  check (kind in ('full', 'external'));
alter table teams add column created_from text not null default 'manual'
  check (created_from in ('import', 'peertube', 'manual', 'videoTitle'));
-- An external team is found by name when the same opponent comes round again.
create index teams_external_name on teams (lower(name)) where kind = 'external';
`,
  down: `
drop index if exists teams_external_name;
alter table teams drop column if exists created_from;
alter table teams drop column if exists kind;

drop index if exists users_merged_into;
alter table users drop column if exists merged_into;

alter table users add column email text;
update users u set email = (
  select ue.email from user_emails ue
  where ue.user_id = u.id
  order by ue.is_primary desc, ue.created_at
  limit 1
);
create unique index users_email_key on users (lower(email)) where email is not null;

drop table if exists user_emails;
`
}
