import type { Migration } from '../runner'

/**
 * Sponsor features: what each league holds, the media its administrators
 * upload, the logos, reels and sponsored rows made of them, and where those
 * were placed on games.
 *
 * - `league_sponsor_credits`: a league's 300 game logo credits, 1,000 reel
 *   broadcast credits and 10 event stream slots, the slots a late delete kept
 *   (`kept_slots`), and the position of the last logo and reel placed, for
 *   round-robin. Every league there is now gets its row here; a league made
 *   later gets one when it is created, or when anything first reads it.
 * - `sponsor_media`: a checked upload, never changed. An upload nothing uses
 *   within a day is deleted, with its object, by the hourly sweep.
 * - `sponsor_logos` and `sponsor_reels`: an asset with the credits allocated
 *   to it and the ones used, in the order the league accepted them.
 * - `game_sponsor_logos`: the logo a game was given for one of its teams'
 *   leagues, pinned to its media; charged once the game has been recorded for
 *   30 minutes.
 * - `game_reel_placements`: one broadcast of a reel on a game's clock.
 * - `game_half_ends`: every half-inning end seen, kept once placed or skipped
 *   so a half is new only once.
 * - `sponsor_rows`: a sponsored row in a league's event stream.
 */
export const migration131SponsorFeatures: Migration = {
  name: '131sponsorFeatures',
  up: `
create table league_sponsor_credits (
  league_id text primary key references leagues(id) on delete cascade,
  logo_credits int not null default 300 check (logo_credits >= 0),
  reel_credits int not null default 1000 check (reel_credits >= 0),
  event_slots int not null default 10 check (event_slots >= 0),
  kept_slots int not null default 0 check (kept_slots >= 0),
  logo_turn int not null default 0,
  reel_turn int not null default 0
);
insert into league_sponsor_credits (league_id) select id from leagues;

create table sponsor_media (
  id text primary key,
  league_id text not null references leagues(id) on delete cascade,
  purpose text not null
    check (purpose in ('logo', 'reel', 'rowLogo', 'rowBackground')),
  object_key text not null unique,
  content_type text not null,
  bytes int not null check (bytes > 0),
  sha256 text not null,
  width int not null check (width > 0),
  height int not null check (height > 0),
  duration_ms int check (duration_ms > 0),
  created_by text references users(id),
  created_at timestamptz not null default now()
);
create index sponsor_media_league on sponsor_media(league_id);
create index sponsor_media_created on sponsor_media(created_at);

create table sponsor_logos (
  id text primary key,
  league_id text not null references leagues(id) on delete cascade,
  media_id text not null unique references sponsor_media(id),
  name text not null,
  allocation int not null check (allocation >= 1),
  used int not null default 0 check (used between 0 and allocation),
  active boolean not null default true,
  position int not null,
  accepted_at timestamptz not null default now(),
  deactivated_at timestamptz,
  unique (league_id, position)
);

create table sponsor_reels (
  id text primary key,
  league_id text not null references leagues(id) on delete cascade,
  media_id text not null unique references sponsor_media(id),
  name text not null,
  allocation int not null check (allocation >= 1),
  used int not null default 0 check (used between 0 and allocation),
  active boolean not null default true,
  position int not null,
  accepted_at timestamptz not null default now(),
  deactivated_at timestamptz,
  duration_ms int not null check (duration_ms > 0),
  unique (league_id, position)
);

create table game_sponsor_logos (
  game_id text not null references games(id) on delete cascade,
  league_id text not null references leagues(id) on delete cascade,
  logo_id text references sponsor_logos(id) on delete set null,
  media_id text not null references sponsor_media(id),
  assigned_at timestamptz not null default now(),
  settled_at timestamptz,
  charged boolean not null default false,
  primary key (game_id, league_id)
);
create index game_sponsor_logos_unsettled on game_sponsor_logos(assigned_at)
  where settled_at is null;

create table game_reel_placements (
  id text primary key,
  game_id text not null references games(id) on delete cascade,
  league_id text not null references leagues(id) on delete cascade,
  reel_id text references sponsor_reels(id) on delete set null,
  media_id text not null references sponsor_media(id),
  slot text not null check (slot in ('pregame', 'half')),
  inning int,
  half text check (half in ('top', 'bottom')),
  starts_at timestamptz not null,
  duration_ms int not null check (duration_ms > 0),
  placed_at timestamptz not null default now(),
  unique nulls not distinct (game_id, league_id, slot, inning, half)
);
create index game_reel_placements_game on game_reel_placements(game_id);

create table game_half_ends (
  game_id text not null references games(id) on delete cascade,
  inning int not null,
  half text not null check (half in ('top', 'bottom')),
  at_bat_index int not null,
  state text not null check (state in ('waiting', 'placed', 'skipped')),
  fade_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (game_id, inning, half)
);
create index game_half_ends_waiting on game_half_ends(fade_at)
  where state = 'waiting';

create table sponsor_rows (
  id text primary key,
  league_id text not null references leagues(id) on delete cascade,
  logo_media_id text not null references sponsor_media(id),
  background_media_id text not null references sponsor_media(id),
  title text not null,
  message text not null,
  url text not null,
  text_color text not null default 'dark'
    check (text_color in ('dark', 'white')),
  starts_at timestamptz not null,
  placed_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index sponsor_rows_league on sponsor_rows(league_id, starts_at)
  where deleted_at is null;
`,
  down: `
drop table sponsor_rows;
drop table game_half_ends;
drop table game_reel_placements;
drop table game_sponsor_logos;
drop table sponsor_reels;
drop table sponsor_logos;
drop table sponsor_media;
drop table league_sponsor_credits;
`
}
