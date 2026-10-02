import type { Migration } from '../runner'

/**
 * The at-bat in progress lives on its game.
 *
 * A game scored in GameStation keeps the play still being scored — the
 * pitches so far, the lineup set before the first one — as a Gumbo document
 * on `games."currentPlay"`, never as an `events` row, so every row in
 * `events` is a completed play and nothing that reads plays sees an at-bat
 * without an outcome. It is null between at-bats that have not started and
 * for every game GameStation does not score.
 */
export const migration038CurrentPlay: Migration = {
  name: '038currentPlay',
  up: 'alter table games add column "currentPlay" jsonb;',
  down: 'alter table games drop column if exists "currentPlay";'
}
