import type { Migration } from '../runner'

/**
 * Deleting a recording that replaced another one.
 *
 * `videos.replaced_by` pointed at `videos` with no delete behaviour, so a
 * video that had taken a live recording's place could never be deleted: the
 * row it replaced still pointed at it, and Postgres refused. The delete route
 * takes the objects out of the Space before it touches the row, so the
 * attempt left a video with nothing behind it that still could not be removed
 * — the same shape as `028uploadKeepsItsHistory`, and missed there because
 * that migration fixed the one pointer that had bitten rather than looking
 * for its siblings.
 *
 * `on delete set null`, for the same reason as the other: a recording that
 * was replaced *was* replaced, and that stays true when the replacement is
 * deleted. What stops being true is the pointer.
 *
 * Bringing the recording back out of hiding is the delete route's job, not
 * this constraint's — a foreign key can clear a pointer and nothing else. It
 * does exactly that, and clears the purge date with it: a recording is hidden
 * and dated for deletion only because something took its place, so removing
 * that something removes the reason.
 */
export const migration030ReplacementCanBeDeleted: Migration = {
  name: '030replacementCanBeDeleted',
  up: `
alter table videos drop constraint videos_replaced_by_fkey;
alter table videos
  add constraint videos_replaced_by_fkey
  foreign key (replaced_by) references videos (id) on delete set null;
`,
  down: `
alter table videos drop constraint videos_replaced_by_fkey;
alter table videos
  add constraint videos_replaced_by_fkey
  foreign key (replaced_by) references videos (id);
`
}
