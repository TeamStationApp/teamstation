import type { Migration } from '../runner'

/**
 * Signs out every account that has already been merged into another.
 *
 * A merge now signs the account it closes out of everything as part of the
 * merge (`signOutEverywhere`). Accounts merged before that still hold live
 * sessions, machine tokens and OAuth grants. Authentication refuses them
 * anyway, because their row is closed; this makes the stored state say the
 * same thing, so a list of an account's sessions does not show live ones the
 * server will never honour.
 *
 * Sessions and machine tokens are marked revoked, keeping when they were last
 * used. OAuth records under the closed accounts' grants are deleted, which is
 * how the provider revokes them.
 *
 * Down changes nothing: a revoked session is not brought back to life, and the
 * accounts these belonged to are still closed.
 */
export const migration052SignOutMergedAccounts: Migration = {
  name: '052signOutMergedAccounts',
  up: `
update auth_sessions s set revoked_at = now()
from users u
where u.id = s.user_id and u.merged_into is not null and s.revoked_at is null;

update api_tokens t set revoked_at = now()
from users u
where u.id = t.user_id and u.merged_into is not null and t.revoked_at is null;

delete from oauth_records r
using oauth_grant_sessions g
join users u on u.id = g.user_id
where u.merged_into is not null
  and (r.grant_hash = g.grant_hash or (r.model = 'Grant' and r.id_hash = g.grant_hash));

delete from oauth_grant_sessions g
using users u
where u.id = g.user_id and u.merged_into is not null;
`,
  down: `
select 1;
`
}
