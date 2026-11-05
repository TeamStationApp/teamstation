import type { Migration } from '../runner'

/**
 * Whether a person has confirmed they are old enough for chat, and how:
 * `apple` when the iPhone's Declared Age Range shared 13 or older, `self`
 * when they agreed to the app's age sheet. Both columns or neither.
 *
 * The app opens chat for a confirmed account; the chat routes do not read it.
 */
export const migration105ChatAgeConfirmations: Migration = {
  name: '105chatAgeConfirmations',
  up: `
alter table users add column chat_age_confirmed_at timestamptz;
alter table users add column chat_age_source text;
alter table users add constraint users_chat_age_check check (
  (chat_age_confirmed_at is null and chat_age_source is null) or
  (chat_age_confirmed_at is not null and chat_age_source is not null and
    chat_age_source in ('apple', 'self')));
`,
  down: `
alter table users drop constraint users_chat_age_check;
alter table users drop column chat_age_source;
alter table users drop column chat_age_confirmed_at;
`
}
