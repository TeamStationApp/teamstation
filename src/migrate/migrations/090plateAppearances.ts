import type { Migration } from '../runner'

/**
 * One row per plate appearance, written by the stats builder beside
 * `game_player_stats` from the same plays, so stats can be split by what
 * the game was when the batter came up: the outs, the runners on base, and
 * how the first pitch went. Rebuilt with the game's other figures whenever
 * the game is; a game built before this table existed has none until it is
 * built again (`npm run backfill-plate-appearances`).
 *
 * `batter_gumbo_id` and `pitcher_gumbo_id` are null for a player TeamStation
 * does not know, as on `game_player_stats`, and become null when the player
 * or team is removed. `first_pitch` is null for a plate appearance whose
 * pitches were not recorded. A row with `is_pa` false carries only outs: a
 * runner caught stealing or picked off, or outs charged to another pitcher
 * than the plate appearance's, so a pitcher's outs add up as on his line.
 *
 * `first_pitch` and `pitches` are the batter's: his plate appearance's
 * first pitch and every pitch of it. `first_pitch_thrown` and
 * `pitches_thrown` are the row's pitcher's: the first pitch if he threw it,
 * and the pitches he threw. A pitcher who came or went in the middle of a
 * plate appearance has a row of his own for the pitches that were his.
 *
 * The runners are null where they are not known: in the half a game's
 * recorded plays begin part way through.
 */
export const migration090PlateAppearances: Migration = {
  name: '090plateAppearances',
  up: `
create table plate_appearances (
  id text primary key,
  game_id text not null references games (id) on delete cascade,
  is_pa boolean not null default true,
  at_bat_index integer not null,
  inning integer not null,
  half_inning text not null check (half_inning in ('top', 'bottom')),
  batter_gumbo_id bigint references gumbo_ids (gumbo_id) on delete set null,
  pitcher_gumbo_id bigint references gumbo_ids (gumbo_id) on delete set null,
  batting_team_id text references teams (id) on delete set null,
  pitching_team_id text references teams (id) on delete set null,
  outs_before smallint check (outs_before >= 0),
  on_first boolean,
  on_second boolean,
  on_third boolean,
  first_pitch text check (first_pitch in ('ball', 'strike', 'inPlay', 'other')),
  pitches smallint not null default 0,
  first_pitch_thrown text
    check (first_pitch_thrown in ('ball', 'strike', 'inPlay', 'other')),
  pitches_thrown smallint not null default 0,
  ab smallint not null default 0,
  h smallint not null default 0,
  singles smallint not null default 0,
  doubles smallint not null default 0,
  triples smallint not null default 0,
  hr smallint not null default 0,
  bb smallint not null default 0,
  k smallint not null default 0,
  hbp smallint not null default 0,
  ci smallint not null default 0,
  sf smallint not null default 0,
  sh smallint not null default 0,
  rbi smallint not null default 0,
  outs_made smallint not null default 0
);
create index plate_appearances_game on plate_appearances (game_id);
create index plate_appearances_batter on plate_appearances (batter_gumbo_id);
create index plate_appearances_pitcher on plate_appearances (pitcher_gumbo_id);
`,
  down: `
drop table plate_appearances;
`
}
