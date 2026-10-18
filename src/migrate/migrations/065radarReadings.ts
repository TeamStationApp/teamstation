import type { Migration } from '../runner'

/** Explicit packet readings, separate from speeds held in board snapshots. */
export const migration065RadarReadings: Migration = {
  name: '065radarReadings',
  up: `
alter table scoreboard_log add column radar jsonb;
create index scoreboard_radar_time on scoreboard_log (game_id, at, version)
  where radar is not null;
`,
  down: `
drop index scoreboard_radar_time;
alter table scoreboard_log drop column radar;
`
}
