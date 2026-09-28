import type { Migration } from '../runner'

/**
 * How far the home-run fence stands, in feet, where a league, a season or a
 * single game sets it.
 *
 * A game's own figure wins, then its season's, then that season's league's,
 * and a game with none anywhere is played to a 200-foot fence. The figure is
 * what turns where the scorer put the ball into how far it went. Null
 * everywhere means "the level above decides".
 *
 * A game's fence is fixed once it has plays, so a game that already has
 * some is given the fence it resolves to now. No league or season has one
 * yet, so that is the 200-foot default, written out here rather than read
 * from the code, whose default may change after this runs.
 */
export const migration042FenceDistance: Migration = {
  name: '042fenceDistance',
  up: `
alter table leagues add column fence_distance_ft integer
  check (fence_distance_ft > 0 and fence_distance_ft <= 600);
alter table seasons add column fence_distance_ft integer
  check (fence_distance_ft > 0 and fence_distance_ft <= 600);
alter table games add column fence_distance_ft integer
  check (fence_distance_ft > 0 and fence_distance_ft <= 600);
update games set fence_distance_ft = 200
  where exists (select 1 from events where events."gameId" = games.id);
`,
  down: `
alter table games drop column if exists fence_distance_ft;
alter table seasons drop column if exists fence_distance_ft;
alter table leagues drop column if exists fence_distance_ft;
`
}
