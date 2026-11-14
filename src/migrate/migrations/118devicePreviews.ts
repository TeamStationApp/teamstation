import type { Migration } from '../runner'

export const migration118DevicePreviews: Migration = {
  name: '118devicePreviews',
  up: `alter table schedule_previews drop constraint schedule_previews_status_check;
alter table schedule_previews add constraint schedule_previews_status_check check (status in ('building','open','published','discarded'));
-- The completed device result's hash, so a retry of it is recognized
-- without rewriting the snapshot.
alter table schedule_previews add column result_hash text;
-- Builds left waiting are swept by age on every preparation.
create index schedule_previews_building_created_at on schedule_previews (created_at) where status = 'building';`,
  down: `drop index schedule_previews_building_created_at;
alter table schedule_previews drop column result_hash;
delete from schedule_previews where status = 'building';
alter table schedule_previews drop constraint schedule_previews_status_check;
alter table schedule_previews add constraint schedule_previews_status_check check (status in ('open','published','discarded'));`
}
