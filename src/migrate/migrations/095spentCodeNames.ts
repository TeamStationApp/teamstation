import type { Migration } from '../runner'

/**
 * A name typed at sign-up stays on its code only while the code is pending.
 * `email_codes.display_name` is what an account made by an invite will be
 * called; once the account is settled the name lives on `users`, and a spent
 * or expired code keeps nothing of it.
 *
 * Up forgets the name on every consumed or expired code and adds the partial
 * index on `expires_at` that issuing a code uses to forget it on codes that
 * expire later. Down drops the index; the names are not put back.
 */
export const migration095SpentCodeNames: Migration = {
  name: '095spentCodeNames',
  up: `
create index email_codes_named_expiry on email_codes (expires_at)
  where display_name is not null;
update email_codes set display_name = null
  where display_name is not null
    and (consumed_at is not null or expires_at <= now());
`,
  down: `
drop index if exists email_codes_named_expiry;
`
}
