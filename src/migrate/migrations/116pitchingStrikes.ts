import type { Migration } from '../runner'

/** Recompute stored detail counts from recorded deliveries and batter credits. */
export const migration116PitchingStrikes: Migration = {
  name: '116pitchingStrikes',
  up: `
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
  down: 'select 1;'
}
