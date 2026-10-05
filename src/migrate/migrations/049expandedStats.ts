import type { Migration } from '../runner'

/** Detail counts are nullable until the existing plays have been rebuilt. */
export const migration049ExpandedStats: Migration = {
  name: '049expandedStats',
  up: `
alter table game_player_stats add column extra jsonb;
insert into game_stats_state (
  game_id, requested_generation, status, attempts, retry_at, requested_at
)
select distinct "gameId", 1, 'pending', 0, null::timestamptz, now()
from events
on conflict (game_id) do update
set requested_generation = game_stats_state.requested_generation + 1,
    status = 'pending', attempts = 0, retry_at = null::timestamptz,
    requested_at = now();
select pg_notify('game_stats', 'all');
`,
  down: 'alter table game_player_stats drop column extra;'
}
