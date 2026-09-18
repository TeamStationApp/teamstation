import type { Migration } from '../runner'

/**
 * A stream key belongs to a person, and a person may hold four of them.
 *
 * It was one key per game, which answered "is this game being streamed" and
 * nothing else. Paul asked for the other question — **who** is streaming it —
 * and for one person to be able to send more than one camera. So the key is
 * now the person's: `user_id` is whose it is, `slot` is which of their four,
 * and `label` is what that camera is called, because four rows named nothing
 * are four rows nobody can tell apart.
 *
 * Four keys are four videos, which is a shape GameStation already has: a game
 * with several recordings is a game with several angles, and the watch screen
 * already switches between them.
 *
 * The backfill is `created_by`, which is exactly who asked for each key.
 */
export const migration015LiveStreamOwners: Migration = {
  name: '015liveStreamOwners',
  up: `
alter table live_streams add column user_id text references users (id)
  on delete cascade;
alter table live_streams add column slot integer not null default 1;
alter table live_streams add column label text;

update live_streams set user_id = created_by where user_id is null;

-- A key with no owner cannot be attributed to anybody, which is the whole
-- point of this change, so a row that has lost its person is revoked rather
-- than left publishing anonymously.
update live_streams set state = 'revoked' where user_id is null;

alter table live_streams add constraint live_streams_slot_range
  check (slot between 1 and 4);

-- One key per person per slot, still ignoring the revoked: those are history.
drop index if exists live_streams_one_per_game;
create unique index live_streams_one_per_slot
  on live_streams (game_id, user_id, slot)
  where state <> 'revoked';

-- The panel and the picker both ask "what is on this game", so that question
-- gets its own index now that the answer is a list rather than a row.
create index live_streams_by_game on live_streams (game_id)
  where state <> 'revoked';
`,
  down: `
drop index if exists live_streams_by_game;
drop index if exists live_streams_one_per_slot;
alter table live_streams drop constraint if exists live_streams_slot_range;
alter table live_streams drop column if exists label;
alter table live_streams drop column if exists slot;
alter table live_streams drop column if exists user_id;
create unique index live_streams_one_per_game on live_streams (game_id)
  where state <> 'revoked';
`
}
