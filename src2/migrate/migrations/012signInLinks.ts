import type { Migration } from '../runner'

/**
 * The sign-in link that sits above the code.
 *
 * The code stays — it is the only thing that works when the mail is read on a
 * different machine from the one signing in — and the link is a second door
 * onto the same sign-in rather than a second sign-in. Either one consumes the
 * row, so a link that has already been used is dead the moment the code is
 * typed, and the other way round.
 *
 * `token_hash`, not the token: an e-mail lives in a mailbox and a database
 * lives in a backup, and neither should hold the thing that signs somebody in.
 *
 * `origin` is recorded when the sign-in is **asked for** rather than guessed
 * when the link is opened, so a sign-in that started in a phone app comes back
 * to the app and one that started in a browser comes back to the browser. The
 * phone app does not exist yet; recording it now is what stops every link
 * having to be reissued the day it does.
 *
 * `client_secret_hash` belongs to the machine that asked, and is what lets a
 * link opened on a laptop finish a sign-in the phone is still waiting on: the
 * waiting client polls with a secret only it holds, and gets its own session
 * once the request has been approved anywhere.
 */
export const migration012SignInLinks: Migration = {
  name: '012signInLinks',
  up: `
alter table email_codes add column token_hash text;
alter table email_codes add column origin text not null default 'web'
  check (origin in ('web', 'ios', 'android'));
alter table email_codes add column next_path text;
alter table email_codes add column client_secret_hash text;
alter table email_codes add column approved_at timestamptz;
create index email_codes_token on email_codes (token_hash)
  where token_hash is not null;
`,
  down: `
drop index if exists email_codes_token;
alter table email_codes drop column if exists approved_at;
alter table email_codes drop column if exists client_secret_hash;
alter table email_codes drop column if exists next_path;
alter table email_codes drop column if exists origin;
alter table email_codes drop column if exists token_hash;
`
}
