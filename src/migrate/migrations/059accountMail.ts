import type { Migration } from '../runner'

/**
 * Account mail is off until a node administrator turns it on.
 *
 * Invitations and notices that somebody was added wait on this row. A sign-in
 * code does not: that mail is the way into an account and is not this setting.
 */
export const migration059AccountMail: Migration = {
  name: '059accountMail',
  up: `
insert into system_settings (key, value) values
  ('mail.accountMessages', 'false'::jsonb);
`,
  down: `
delete from system_settings where key = 'mail.accountMessages';
`
}
