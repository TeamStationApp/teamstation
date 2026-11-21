import type { Migration } from '../runner'

/**
 * A DM member's hidden history: when somebody with no age on file gives an
 * age of 13 to 17 and a DM they were already in then breaks a rule, the DM
 * closes and they are served none of its messages from before they answered
 * (`hidden_before`). They could not read before answering, so no device of
 * theirs holds that history.
 */
export const migration128ChatHiddenHistory: Migration = {
  name: '128chatHiddenHistory',
  up: `alter table chat_members add column hidden_before timestamptz;`,
  down: `alter table chat_members drop column hidden_before;`
}
