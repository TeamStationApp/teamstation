import type { Migration } from '../runner'

/**
 * Each video's secret, the 128 random bits in the path its media lives under
 * in the Space, `videos/<id>-<secret>/`: 32 lowercase hex characters, unique,
 * or null for a video still on `videos/<id>/`. It is set only at a moment
 * when nothing of the video is under its old prefix, so a video's objects
 * never span two prefixes.
 *
 * The secret decides where the ingest's uploader writes, so a change to it is
 * one more `live_changes` notice for its video: `videos_live_changes_update`
 * watches it beside the columns it watched before. The way down puts that
 * trigger back as 101 made it before the column goes.
 */
export const migration102VideoSpaceSecret: Migration = {
  name: '102videoSpaceSecret',
  up: `
alter table videos add column space_secret text;
alter table videos add constraint videos_space_secret_hex
  check (space_secret ~ '^[0-9a-f]{32}$');
alter table videos add constraint videos_space_secret_unique
  unique (space_secret);

create or replace trigger videos_live_changes_update
after update of hidden, storage, spaces_verified_at, replaced_by, start_at, space_secret
on videos for each row
when ((old.hidden, old.storage, old.spaces_verified_at, old.replaced_by, old.start_at, old.space_secret)
      is distinct from (new.hidden, new.storage, new.spaces_verified_at, new.replaced_by, new.start_at, new.space_secret))
execute function videos_live_changes();
`,
  down: `
create or replace trigger videos_live_changes_update
after update of hidden, storage, spaces_verified_at, replaced_by, start_at
on videos
for each row
when (
  (old.hidden, old.storage, old.spaces_verified_at, old.replaced_by,
   old.start_at)
  is distinct from
  (new.hidden, new.storage, new.spaces_verified_at, new.replaced_by,
   new.start_at)
)
execute function videos_live_changes();

alter table videos drop column space_secret;
`
}
