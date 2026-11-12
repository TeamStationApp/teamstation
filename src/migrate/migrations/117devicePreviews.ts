import type { Migration } from '../runner'

export const migration117DevicePreviews: Migration = {
  name: '117devicePreviews',
  up: `alter table schedule_previews drop constraint schedule_previews_status_check;
alter table schedule_previews add constraint schedule_previews_status_check check (status in ('building','open','published','discarded'));`,
  down: `delete from schedule_previews where status = 'building';
alter table schedule_previews drop constraint schedule_previews_status_check;
alter table schedule_previews add constraint schedule_previews_status_check check (status in ('open','published','discarded'));`
}
