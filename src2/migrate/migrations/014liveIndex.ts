import type { Migration } from '../runner'

/**
 * Finding what is live.
 *
 * The home screen asks on every load, for everybody, and the answer on almost
 * every day of the year is nothing at all. Without an index that question is a
 * scan of every video ever recorded to learn that none of them is on now.
 *
 * Partial, because the rows it covers are the handful that are live this
 * afternoon: the index stays the size of a page no matter how many seasons
 * pile up behind it.
 */
export const migration014LiveIndex: Migration = {
  name: '014liveIndex',
  up: `
create index videos_live on videos (start_at desc)
  where status = 'live' and hidden = false;
`,
  down: `
drop index if exists videos_live;
`
}
