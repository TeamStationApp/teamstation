import type { Migration } from '../runner'

/**
 * A stream key is open from the moment it is issued.
 *
 * It used to open two hours before the first pitch, and the first time anybody
 * tried to test one they were told "this game's stream is not open yet" for a
 * fixture two days out. A key that cannot be tried until the moment it is
 * needed is one whose URL you find out is wrong during the game.
 *
 * The column stays, because when a key became usable is worth knowing; what
 * changes is what goes in it. Keys already issued are moved back to the moment
 * they were created, which is the answer the new rule would have given them.
 *
 * The closing end is untouched. That is the bound that matters: a key still
 * working a week after the game is a publish credential nobody remembers
 * issuing.
 */
export const migration017OpenFromIssue: Migration = {
  name: '017openFromIssue',
  up: `
update live_streams set opens_at = created_at where opens_at > created_at;
`,
  // Nothing to put back: the old value was a function of the game's start time
  // and a setting that no longer exists, so it cannot be recomputed here. The
  // column is still a timestamp in the past, which is what every reader wants.
  down: ``
}
