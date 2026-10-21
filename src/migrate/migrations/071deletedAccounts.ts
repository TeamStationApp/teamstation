import type { Migration } from '../runner'

/**
 * A deleted account is marked as such, apart from suspension: a suspension can
 * be lifted, a deletion cannot. A deleted row stays disabled for good, so
 * nothing that lifts a suspension can open it again.
 */
export const migration071DeletedAccounts: Migration = {
  name: '071deletedAccounts',
  up: `
alter table users add column deleted_at timestamptz;
alter table users add constraint users_deleted_stays_disabled
  check (deleted_at is null or disabled_at is not null);
`,
  // Dropping the mark would make every deleted account one lifted suspension
  // from signing in again.
  down: `do $restore$ begin
    raise exception 'Restore the verified pre-cutover backup and matching code; deleted accounts cannot be un-deleted';
  end $restore$;`
}
