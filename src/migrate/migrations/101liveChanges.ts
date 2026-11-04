import type { Migration } from '../runner'

/**
 * Tells the ingest and every API worker, on `live_changes`, when a stream, its
 * video or its game changes, whoever wrote it. A notice goes out when its
 * transaction commits, and never for a transaction that rolls back.
 *
 * - `live_streams`: an insert, a delete, or an update that changes anything
 *   other than the ingest's own reports (`status`, `status_at`,
 *   `last_published_at`, `updated_at`, `last_error`), so the ingest's status
 *   writes never wake it. Payload `{"s": <stream id>, "v": <video id or null>}`.
 * - `videos`, every kind: a delete, or an update that changes `hidden`,
 *   `storage`, `spaces_verified_at`, `replaced_by` or `start_at`. Payload
 *   `{"v": <video id>}`.
 * - `games`: an update that changes `start_at`, `end_at`, `home_team_id` or
 *   `away_team_id` while a stream of that game has not ended. Payload
 *   `{"g": <game id>}`.
 *
 * An update names its columns twice, in `update of` and in `when`, so a write
 * that sets a column to the value it had says nothing.
 */
export const migration101LiveChanges: Migration = {
  name: '101liveChanges',
  up: `
create function live_streams_live_changes() returns trigger
language plpgsql as $$
declare
  stream live_streams;
begin
  if tg_op = 'DELETE' then
    stream := old;
  else
    stream := new;
  end if;
  perform pg_notify(
    'live_changes',
    json_build_object('s', stream.id, 'v', stream.video_id)::text
  );
  return null;
end
$$;

create trigger live_streams_live_changes
after insert or delete on live_streams
for each row execute function live_streams_live_changes();

create trigger live_streams_live_changes_update
after update on live_streams
for each row
when (
  (to_jsonb(old) - array['status', 'status_at', 'last_published_at',
                         'updated_at', 'last_error'])
  is distinct from
  (to_jsonb(new) - array['status', 'status_at', 'last_published_at',
                         'updated_at', 'last_error'])
)
execute function live_streams_live_changes();

create function videos_live_changes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform pg_notify('live_changes', json_build_object('v', old.id)::text);
  else
    perform pg_notify('live_changes', json_build_object('v', new.id)::text);
  end if;
  return null;
end
$$;

create trigger videos_live_changes
after delete on videos
for each row execute function videos_live_changes();

create trigger videos_live_changes_update
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

create function games_live_changes() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from live_streams
     where game_id = new.id and ended_at is null
  ) then
    perform pg_notify('live_changes', json_build_object('g', new.id)::text);
  end if;
  return null;
end
$$;

create trigger games_live_changes
after update of start_at, end_at, home_team_id, away_team_id on games
for each row
when (
  (old.start_at, old.end_at, old.home_team_id, old.away_team_id)
  is distinct from
  (new.start_at, new.end_at, new.home_team_id, new.away_team_id)
)
execute function games_live_changes();
`,
  down: `
drop trigger games_live_changes on games;
drop function games_live_changes();
drop trigger videos_live_changes_update on videos;
drop trigger videos_live_changes on videos;
drop function videos_live_changes();
drop trigger live_streams_live_changes_update on live_streams;
drop trigger live_streams_live_changes on live_streams;
drop function live_streams_live_changes();
`
}
