import type { Migration } from '../runner'

/**
 * Finding every play one player is credited on.
 *
 * A player's own page is a list of their highlights across every game they
 * have ever played, which asks the opposite question from the one the game
 * screen asks: not *what happened in this game* but *where does this person
 * appear*. The answer lives inside `events.credits`, a jsonb array of the
 * outcomes a play yielded, and without an index that is a sequential scan of
 * every play ever recorded for each page opened.
 *
 * `jsonb_path_ops` rather than the default: it indexes only the containment
 * operator, which is the one this query uses, and is smaller and faster for
 * it than the general form.
 */
export const migration022CreditIndex: Migration = {
  name: '022creditIndex',
  up: `
create index events_credits on events using gin (credits jsonb_path_ops);
`,
  down: `
drop index if exists events_credits;
`
}
