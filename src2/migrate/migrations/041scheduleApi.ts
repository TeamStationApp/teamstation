import type { Migration } from '../runner'

/**
 * A schedule can be written through the API, by any caller naming its own
 * system.
 *
 * `external_ids.system` was a fixed list, so an id from a system outside it
 * failed on the check. It becomes a pattern instead: a short camel-case name
 * the caller chooses. A team the API makes for an opponent it has never seen
 * is recorded as `created_from = 'api'`.
 *
 * Down turns `api` teams into `manual` ones and puts the old list back
 * `not valid`, so an id another system wrote survives the rollback.
 */
export const migration041ScheduleApi: Migration = {
  name: '041scheduleApi',
  up: `
alter table external_ids drop constraint external_ids_system_check;
alter table external_ids add constraint external_ids_system_check
  check (system ~ '^[a-z][a-zA-Z0-9]{0,31}$');

alter table teams drop constraint teams_created_from_check;
alter table teams add constraint teams_created_from_check
  check (created_from in ('import', 'peertube', 'manual', 'videoTitle', 'api'));
`,
  down: `
update teams set created_from = 'manual' where created_from = 'api';
alter table teams drop constraint teams_created_from_check;
alter table teams add constraint teams_created_from_check
  check (created_from in ('import', 'peertube', 'manual', 'videoTitle'));

alter table external_ids drop constraint external_ids_system_check;
alter table external_ids add constraint external_ids_system_check
  check (system in ('peertube', 'external')) not valid;
`
}
