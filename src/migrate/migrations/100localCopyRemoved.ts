import type { Migration } from '../runner'

/**
 * A phone's recording of a camera that is gone from the phone, deleted by hand
 * or by its 30-day limit, without being uploaded: `local_recording` `removed`.
 *
 * Rolling back turns those rows into `none`, which is what they read as to
 * every client.
 */
export const migration100LocalCopyRemoved: Migration = {
  name: '100localCopyRemoved',
  up: `
alter table live_streams drop constraint live_streams_local_recording_check;
alter table live_streams add constraint live_streams_local_recording_check
  check (local_recording in ('none', 'recorded', 'uploaded', 'removed'));
`,
  down: `
update live_streams set local_recording = 'none' where local_recording = 'removed';
alter table live_streams drop constraint live_streams_local_recording_check;
alter table live_streams add constraint live_streams_local_recording_check
  check (local_recording in ('none', 'recorded', 'uploaded'));
`
}
