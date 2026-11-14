import type { Migration } from '../runner'

/**
 * A completed device result's hash on its own column, so a retry is
 * recognized without rewriting the snapshot, and an index for the sweep of
 * builds left waiting.
 */
export const migration119DeviceResultHash: Migration = {
  name: '119deviceResultHash',
  up: `alter table schedule_previews add column result_hash text;
create index schedule_previews_building_created_at on schedule_previews (created_at) where status = 'building';`,
  down: `drop index schedule_previews_building_created_at;
alter table schedule_previews drop column result_hash;`
}
