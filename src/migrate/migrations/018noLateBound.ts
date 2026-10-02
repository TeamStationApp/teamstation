import type { Migration } from '../runner'

/**
 * A stream key does not expire on a clock at all.
 *
 * 017 took away the early bound so a key could be tried before the day. This
 * takes away the late one for the same reason: publishing to a game that has
 * already finished is how somebody tests the whole path — key, ingest, packing,
 * playback — without waiting for a fixture, and there is no hour at which that
 * stops being a reasonable thing to want.
 *
 * So `closes_at` stops meaning "when the window shuts" and starts meaning
 * **"when somebody ended this"**, which is null until they do. The mechanism is
 * unchanged: End stream still writes the moment, and the ingest still notices
 * within the second and closes the playlist. What is gone is the clock that
 * wrote that moment on a key's behalf.
 *
 * Keys still in use stop expiring. Keys somebody already ended keep the moment
 * they were ended, because that is what it now records.
 */
export const migration018NoLateBound: Migration = {
  name: '018noLateBound',
  up: `
alter table live_streams alter column closes_at drop not null;
update live_streams set closes_at = null
  where state in ('idle', 'publishing');
`,
  // Anything still open is given a day, which is long enough that nothing is
  // cut off by going back and short enough that the column is not lying.
  down: `
update live_streams set closes_at = now() + interval '1 day'
  where closes_at is null;
alter table live_streams alter column closes_at set not null;
`
}
