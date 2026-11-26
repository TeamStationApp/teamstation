import type { Migration } from '../runner'

/**
 * The board timeline's version counts a game's resets and late exit readings,
 * the rows logged without a newer version (`boardTimeline.ts`). Its predicate
 * is this index's, word for word, so the count reads only those rows.
 */
export const migration131ScoreboardLateRows: Migration = {
  name: '131scoreboardLateRows',
  up: `
create index scoreboard_log_late_rows on scoreboard_log (game_id)
  where cause = 'reset' or (radar @> '{"measurementOnly":true}'::jsonb and radar ? 'exitVelocity');
`,
  down: `
drop index scoreboard_log_late_rows;
`
}
