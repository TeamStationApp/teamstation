import type { Migration } from '../runner'

/**
 * An invite made out to one address.
 *
 * A link anybody may use is the right thing for a team sheet, and the wrong
 * thing for "add this one parent". An administrator typing an address wants
 * that person in, not a code to pass around, so the row records who it was
 * for: the invitation is mailed to them, it is good for one use, and the
 * people list can show them as invited rather than silently nothing until
 * they get round to opening it.
 *
 * Only ever the address it was sent to. Redeeming is still what makes a
 * membership, and it is still the sign-in that proves the address is theirs —
 * an invitation addressed to somebody is not a claim that they have read it.
 */
export const migration020InviteEmails: Migration = {
  name: '020inviteEmails',
  up: `
alter table invites add column for_email text;
create index invites_for_email on invites (lower(for_email))
  where for_email is not null;
`,
  down: `
drop index if exists invites_for_email;
alter table invites drop column if exists for_email;
`
}
