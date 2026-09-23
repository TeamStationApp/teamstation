import type { Migration } from '../runner'

/**
 * A Director sends its recording to the library, and the live stream steps
 * aside for it.
 *
 * **Why an upload needs a row of its own.** A take is a two-hour recording
 * leaving a ball field on whatever network the field has, which is usually a
 * phone. An upload that has to start again from nought after a dropped
 * connection is an upload that never finishes, so it arrives in parts and the
 * Director asks what has landed before sending more. That answer has to
 * survive the server restarting, which means it is a row and not a map in
 * memory.
 *
 * The parts themselves are files on disk; this says what the upload is *for*,
 * because that is what the server cannot work out by looking at a directory:
 * whose it is, which game it belongs to, and what it is called when it lands.
 *
 * **Why the live recording is not simply deleted.** The upload is the same
 * game, filmed by the same rig, without the losses of the field's uplink — so
 * it replaces the stream everywhere the stream shows. But a replacement that
 * deletes on the spot is a replacement nobody can undo, and the live copy is
 * the only one until the upload has verified. So the live row is hidden at
 * once and carries the date it may be purged: off every page immediately, and
 * gone for good a month later — once a deployment turns the sweep on. The
 * date is written everywhere; `purgeReplacedRecordings` decides whether
 * anything acts on it, and it is off unless a deployment owns the bytes.
 */
export const migration026DirectorUploads: Migration = {
  name: '026directorUploads',
  up: `
create table director_uploads (
  id text primary key,
  user_id text not null references users (id),
  game_id text references games (id),
  title text not null,
  kind text not null default 'program',
  -- What the Director calls the file it is sending, for the log and for a
  -- human trying to work out which take this was.
  filename text not null,
  size_bytes bigint not null check (size_bytes > 0),
  part_size integer not null check (part_size > 0),
  -- 'open' while parts arrive, then the one-way trip through the ingest.
  state text not null default 'open'
    check (state in ('open', 'assembling', 'ready', 'failed', 'abandoned')),
  received_bytes bigint not null default 0,
  video_id text references videos (id),
  message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index director_uploads_user_idx on director_uploads (user_id, created_at desc);
create index director_uploads_game_idx on director_uploads (game_id)
  where game_id is not null;

alter table videos
  -- Set when something better takes this recording's place. The row is
  -- hidden from the moment it is set; this is when it may be deleted, along
  -- with its objects in the Space.
  add column purge_after timestamptz,
  add column replaced_by text references videos (id);

create index videos_purge_idx on videos (purge_after)
  where purge_after is not null;
`,
  down: `
drop index if exists videos_purge_idx;
alter table videos
  drop column if exists replaced_by,
  drop column if exists purge_after;
drop table if exists director_uploads;
`
}
