import type { Migration } from '../runner'

/**
 * A player's names folded for a typed search: lower case, accents taken off,
 * so "jose" finds "José". `GET /users?forTeam=` matches each word the asker
 * typed against the start of a first, last or display name through
 * `ts_name_fold`, on both sides, and these indexes serve that prefix match
 * under any collation (`text_pattern_ops`).
 *
 * `unaccent(text)` is only stable, so an index cannot call it. The wrapper
 * names its dictionary, the two-argument form, which does not depend on the
 * search path, and is declared immutable, as 063 does for its own index.
 *
 * Rolling back drops the indexes, the wrapper and the extension.
 */
export const migration096RosterCandidateNames: Migration = {
  name: '096rosterCandidateNames',
  up: `
create extension if not exists unaccent with schema public;
create function ts_name_fold(name text) returns text
language sql immutable parallel safe as $$
  select lower(public.unaccent('public.unaccent'::regdictionary, coalesce(name, '')))
$$;
create index users_first_name_fold
  on users (ts_name_fold(first_name) text_pattern_ops);
create index users_last_name_fold
  on users (ts_name_fold(last_name) text_pattern_ops);
create index users_display_name_fold
  on users (ts_name_fold(display_name) text_pattern_ops);
`,
  down: `
drop index users_display_name_fold;
drop index users_last_name_fold;
drop index users_first_name_fold;
drop function ts_name_fold(text);
drop extension if exists unaccent;
`
}
