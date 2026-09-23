import type { Migration } from '../runner'

/**
 * Deleting an uploaded recording must not be blocked by the record of its
 * upload.
 *
 * `director_uploads.video_id` pointed at `videos` with no delete behaviour, so
 * Postgres refused to delete any video an upload had made: the delete route
 * removed the objects from the Space, then failed on the row, leaving a video
 * that pointed at nothing and could not be got rid of. Found by deleting a
 * test upload; it would have happened to the first real one somebody tried to
 * remove.
 *
 * `on delete set null` rather than `on delete cascade`: the upload row is the
 * history of a transfer that really happened — who sent what, when, how much
 * arrived — and that stays true after the video it produced is deleted. What
 * stops being true is the pointer.
 */
export const migration028UploadKeepsItsHistory: Migration = {
  name: '028uploadKeepsItsHistory',
  up: `
alter table director_uploads
  drop constraint director_uploads_video_id_fkey;
alter table director_uploads
  add constraint director_uploads_video_id_fkey
  foreign key (video_id) references videos (id) on delete set null;
`,
  down: `
alter table director_uploads
  drop constraint director_uploads_video_id_fkey;
alter table director_uploads
  add constraint director_uploads_video_id_fkey
  foreign key (video_id) references videos (id);
`
}
