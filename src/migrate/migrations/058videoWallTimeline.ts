import type { Migration } from '../runner'

/**
 * Where each moment of a video falls on the server's clock.
 *
 * `video_wall_anchors` holds a video's timeline as points: `media_ms` is a
 * position in the video as a player reports it (playlist time, the
 * player's `currentTime`), and `wall` is the server-clock instant the frame
 * there was taken. Between two points the video runs at 1×. `source` says
 * where a point came from: `sei` for a wall clock the frame itself carries,
 * `arrival` for when the server took a live segment in. `corrected` is false
 * for a wall clock stamped on a device that had not measured the server's
 * clock, which is then only as good as that device's own.
 *
 * A video with no points is placed by its `start_at`.
 * `videos.start_at_clock_offset_ms` says that start was moved onto the
 * server's clock by a measured offset (an upload whose app measured one),
 * and `director_uploads.server_clock_offset_ms` carries that offset from the
 * upload's open to the video it becomes. Both are null for everything else.
 *
 * Down drops the table and both columns, and every value in them.
 */
export const migration058VideoWallTimeline: Migration = {
  name: '058videoWallTimeline',
  up: `
create table video_wall_anchors (
  video_id text not null references videos (id) on delete cascade,
  media_ms integer not null,
  wall timestamptz(3) not null,
  source text not null check (source in ('sei', 'arrival')),
  corrected boolean not null default true,
  primary key (video_id, media_ms)
);
alter table videos add column start_at_clock_offset_ms integer;
alter table director_uploads add column server_clock_offset_ms integer;
`,
  down: `
alter table director_uploads drop column server_clock_offset_ms;
alter table videos drop column start_at_clock_offset_ms;
drop table video_wall_anchors;
`
}
