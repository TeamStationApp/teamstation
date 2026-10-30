import type { Migration } from '../runner'

/**
 * Cameras that have ended stay on the game and stop counting against it.
 *
 * `source` says what an external camera is, and `discarded_at` that its owner
 * deleted it. Both unique indexes now cover active rows only, so an ended
 * camera holds neither a slot nor a name: its row stays for its video and a
 * new camera takes the place.
 *
 * A camera replaced by its phone's upload used to be revoked, which hid it.
 * It becomes an ordinary ended row, closed so its key cannot publish. That
 * runs between dropping the old indexes and building the new ones, because
 * such a row and a later camera can already share a slot.
 *
 * Rolling back is refused while two non-revoked rows share a slot or a device
 * label, because the old indexes cannot hold them.
 */
export const migration098StreamManagement: Migration = {
  name: '098streamManagement',
  up: `
alter table live_streams add column source text;
alter table live_streams add column discarded_at timestamptz;

drop index live_streams_one_per_slot;
drop index live_streams_one_per_device_label;

update live_streams
   set state = 'ended',
       closes_at = coalesce(closes_at, now()),
       updated_at = now()
 where state = 'revoked' and local_recording = 'uploaded';

create unique index live_streams_one_per_slot
  on live_streams (game_id, user_id, slot)
  where state not in ('revoked', 'ended') and closes_at is null;
create unique index live_streams_one_per_device_label
  on live_streams (game_id, user_id, device_id, lower(label))
  where device_id is not null
    and state not in ('revoked', 'ended')
    and closes_at is null;
`,
  down: `
do $refuse$ begin
  if exists (select 1 from live_streams
              where state <> 'revoked'
              group by game_id, user_id, slot
             having count(*) > 1)
     or exists (select 1 from live_streams
                 where device_id is not null
                   and state <> 'revoked'
                   and closes_at is null
                   and label is not null
                 group by game_id, user_id, device_id, lower(label)
                having count(*) > 1) then
    raise exception 'Cameras share a slot or a device label; remove them before rolling this back';
  end if;
end $refuse$;
drop index live_streams_one_per_device_label;
drop index live_streams_one_per_slot;
create unique index live_streams_one_per_slot
  on live_streams (game_id, user_id, slot)
  where state <> 'revoked';
create unique index live_streams_one_per_device_label
  on live_streams (game_id, user_id, device_id, lower(label))
  where device_id is not null and state <> 'revoked' and closes_at is null;
alter table live_streams drop column discarded_at;
alter table live_streams drop column source;
`
}
