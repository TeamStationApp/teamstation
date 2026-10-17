import type { Migration } from '../runner'

/**
 * Streams keyed by the device that holds them, the recording a phone keeps,
 * and reminders a person can dismiss.
 *
 * **One slot per device and camera name.** A phone, or TS Director, asks for
 * its stream by its own install id and the name of the camera angle, so asking
 * again — a redial, a relaunch — finds the same key instead of taking another
 * of the person's four slots. `device_id` is null on every stream made before
 * this, and on every stream a browser or streaming software asks for. The
 * unique index carries the same predicate as an *active* stream: not revoked,
 * and not ended (`closes_at` set), so an ended angle's name is free again.
 *
 * **What the phone recorded.** `records_locally` marks a stream whose phone
 * keeps its own recording; only that phone's upload replaces its live copy.
 * `local_recording` says how far that recording has got: `none`, `recorded`
 * on the phone, or `uploaded` and standing in for the live copy.
 *
 * **Which streams a Director build claimed.** `director_claimed` is set by the
 * legacy claim route, so a device that updates mid-game adopts the stream the
 * old build held, and never a stream made on the website for streaming
 * software. The streams that route returned before this are marked too: each
 * claim left an audit row naming its stream. Unmarked, a stream an installed
 * Director had published on would be passed over by its next claim, which
 * would make a new stream, splitting a game live during the deploy across two
 * keys and two videos.
 *
 * **Uploads that name their stream.** `director_uploads.live_stream_id` is the
 * angle an upload replaces, and `whole_stream` says the recording ran for every
 * moment that stream published, so the replacement skips the coverage test.
 * A deleted game takes its streams with it, so the link is cleared rather than
 * holding the game up.
 *
 * **Dismissing.** `notification_receipts.dismissed_at` takes a reminder out of
 * Pending and into History.
 *
 * **Placed by its publisher.** `videos.start_at_source` may say `publisher`:
 * a live video whose phone or Director said when its first picture was
 * captured, rather than one placed when the server first heard it. A phone's
 * picture reaches the server up to a second after it was taken, and by a
 * different amount on each phone, so the arrival put two angles of one game
 * out of step.
 */
export const migration062PhoneStreams: Migration = {
  name: '062phoneStreams',
  up: `
alter table live_streams add column device_id text;
alter table live_streams add column device_model text;
alter table live_streams add column local_recording text not null default 'none';
alter table live_streams add constraint live_streams_local_recording_check
  check (local_recording in ('none', 'recorded', 'uploaded'));
alter table live_streams add column records_locally boolean not null default false;
alter table live_streams add column director_claimed boolean not null default false;
update live_streams set director_claimed = true
  where device_id is null
    and id in (
      select entity_id from audit_log
        where entity_type = 'liveStream'
          and method = 'POST'
          and path like '%/director/events/%/claim'
    );

create unique index live_streams_one_per_device_label
  on live_streams (game_id, user_id, device_id, lower(label))
  where device_id is not null and state <> 'revoked' and closes_at is null;

alter table director_uploads add column live_stream_id text
  references live_streams (id) on delete set null;
alter table director_uploads add column whole_stream boolean not null default false;

alter table notification_receipts add column dismissed_at timestamptz;

alter table videos drop constraint videos_start_at_source_check;
alter table videos add constraint videos_start_at_source_check
  check (start_at_source in (
    'obsFilename', 'liveSession', 'originallyPublishedAt', 'distributor',
    'manual', 'publisher'
  ));
`,
  down: `
update videos set start_at_source = 'liveSession'
  where start_at_source = 'publisher';
alter table videos drop constraint videos_start_at_source_check;
alter table videos add constraint videos_start_at_source_check
  check (start_at_source in (
    'obsFilename', 'liveSession', 'originallyPublishedAt', 'distributor',
    'manual'
  ));

alter table notification_receipts drop column if exists dismissed_at;

alter table director_uploads drop column if exists whole_stream;
alter table director_uploads drop column if exists live_stream_id;

drop index if exists live_streams_one_per_device_label;
alter table live_streams drop column if exists director_claimed;
alter table live_streams drop column if exists records_locally;
alter table live_streams drop constraint if exists live_streams_local_recording_check;
alter table live_streams drop column if exists local_recording;
alter table live_streams drop column if exists device_model;
alter table live_streams drop column if exists device_id;
`
}
