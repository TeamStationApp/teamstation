import type { Migration } from '../runner'

/**
 * Live streaming into a game.
 *
 * A **live stream** is a destination a game can be given: an RTMP URL with a
 * key in it, pasted into streaming software or picked from a list by GS
 * Director. One key belongs to one game, which is why the unique index is
 * partial — a revoked key stays on the table as history, and the game can be
 * given a new one.
 *
 * The key is kept twice, and the two are for different things. `key_hash` is
 * what an incoming publish is checked against, so a stolen database cannot be
 * used to publish. `key_cipher` is the key itself, sealed, because unlike a
 * session token this secret has to be **shown again**: it is printed on a
 * screen to be copied into OBS.
 *
 * `videos.kind` gains `live`. It stays `live` after the stream has finished
 * and become an ordinary recording, so "this came from a live stream" is a
 * fact about the video rather than something inferred from its status.
 */
export const migration013Live: Migration = {
  name: '013live',
  up: `
alter table videos drop constraint videos_kind_check;
alter table videos add constraint videos_kind_check
  check (kind in ('program', 'combined', 'live'));

create table live_streams (
  id text primary key,
  game_id text not null references games (id) on delete cascade,
  team_id text not null references teams (id) on delete restrict,
  key_hash text not null unique,
  key_prefix text not null,
  key_cipher text not null,
  state text not null default 'idle'
    check (state in ('idle', 'publishing', 'ended', 'revoked')),
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  video_id text references videos (id) on delete set null,
  status jsonb,
  status_at timestamptz,
  last_error text,
  first_published_at timestamptz,
  last_published_at timestamptz,
  ended_at timestamptz,
  created_by text references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live key per game, but only among keys that are still worth something:
-- a revoked one is history and must not stand in the way of the next.
create unique index live_streams_one_per_game on live_streams (game_id)
  where state <> 'revoked';

-- The ingest reads these two on a short timer: everything it must act on,
-- and nothing it must not.
create index live_streams_open on live_streams (closes_at)
  where state in ('idle', 'publishing');
create index live_streams_video on live_streams (video_id)
  where video_id is not null;

-- What a session is, when it is a thing rather than a browser tab.
--
-- Here rather than in a migration of its own because it exists for this
-- feature: GS Director signs in once and is used every weekend from a field,
-- so its session lasts a season, and a list of them has to read like a list of
-- iPads rather than of user agents.
alter table auth_sessions add column device_name text;
`,
  down: `
alter table auth_sessions drop column if exists device_name;
drop table if exists live_streams;
alter table videos drop constraint videos_kind_check;
alter table videos add constraint videos_kind_check
  check (kind in ('program', 'combined'));
`
}
