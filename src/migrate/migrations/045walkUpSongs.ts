import type { Migration } from '../runner'

/**
 * Each player's walk-up song on each team they play for: one row per team
 * and player, set by a songkeeper.
 *
 * - `provider` is `appleMusic` or `localFile`. `provider_id` is the Apple
 *   Music catalog id, or for a file on a phone `lf:` and the first 16 hex
 *   characters of a sha256 of its normalised title, artist and whole-second
 *   duration (`src/common/walkUpSong.ts`).
 * - The clip is `start_ms` to `end_ms` within `duration_ms`, one second to
 *   one minute long.
 *
 * A row goes with its team or its player. Down drops the table.
 */
export const migration045WalkUpSongs: Migration = {
  name: '045walkUpSongs',
  up: `
create table walk_up_songs (
  team_id      text        not null references teams(id) on delete cascade,
  user_id      bigint      not null references users(id) on delete cascade,
  provider     text        not null check (provider in ('appleMusic', 'localFile')),
  provider_id  text        not null,
  isrc         text,
  title        text        not null,
  artist       text        not null,
  album        text,
  artwork_url  text,
  duration_ms  integer     not null check (duration_ms > 0),
  start_ms     integer     not null check (start_ms >= 0),
  end_ms       integer     not null,
  set_by       bigint      not null references users(id),
  set_at       timestamptz not null default now(),
  primary key (team_id, user_id),
  check (
    end_ms > start_ms
    and end_ms <= duration_ms
    and end_ms - start_ms between 1000 and 60000
  )
);
create index walk_up_songs_user on walk_up_songs (user_id);
`,
  down: `
drop table walk_up_songs;
`
}
