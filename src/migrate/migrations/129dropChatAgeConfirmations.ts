import type { Migration } from '../runner'

/**
 * Drops the 13-or-older confirmation (105chatAgeConfirmations): every chat
 * permission reads a person's age band now (127ageBands). Its rows were test
 * data only, so nothing is carried over; going down brings the columns back
 * empty.
 */
export const migration129DropChatAgeConfirmations: Migration = {
  name: '129dropChatAgeConfirmations',
  up: `
alter table users drop constraint users_chat_age_check;
alter table users drop column chat_age_source;
alter table users drop column chat_age_confirmed_at;
`,
  down: `
alter table users add column chat_age_confirmed_at timestamptz;
alter table users add column chat_age_source text;
alter table users add constraint users_chat_age_check check (
  (chat_age_confirmed_at is null and chat_age_source is null) or
  (chat_age_confirmed_at is not null and chat_age_source is not null and
    chat_age_source in ('apple', 'self')));
`
}
