import type { Migration } from '../runner'

/**
 * One row per player per game: the figures, as the scorebook counts them.
 *
 * Everything on a screen used to be added up from the stored plays, which are
 * sentences with player ids in them. That was honest about hits and walks and
 * wrong about the rest — runs scored, runs charged, RBI on an error, at-bats,
 * earned runs — because a sentence does not say who was on base or who was
 * pitching. The figures are now counted by walking the game's plays, and they
 * agreed with the published box scores on every figure of all 95 games held
 * when this was written.
 *
 * Per game, because that is the only grain that can be checked. A season total
 * can be right by two mistakes cancelling, and a career is whichever seasons
 * and teams a parent chooses — so a career is a sum of these rows, a season is
 * a sum of these rows, and a box score is these rows. There is nowhere for the
 * three to disagree.
 *
 * This table is ours, derived, and safe to throw away and rebuild: a re-ingest
 * replaces the game's rows outright. The season cache that once sat beside it,
 * `player_season_stats`, is gone since migration 048.
 */
export const migration023GameStats: Migration = {
  name: '023gameStats',
  up: `
create table game_player_stats (
  id text primary key,
  game_id text not null references games(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  team_id text references teams(id) on delete set null,
  pa integer not null default 0,
  ab integer not null default 0,
  h integer not null default 0,
  singles integer not null default 0,
  doubles integer not null default 0,
  triples integer not null default 0,
  hr integer not null default 0,
  bb integer not null default 0,
  k integer not null default 0,
  r integer not null default 0,
  rbi integer not null default 0,
  hbp integer not null default 0,
  ci integer not null default 0,
  sf integer not null default 0,
  sb integer not null default 0,
  cs integer not null default 0,
  pitch_bf integer not null default 0,
  pitch_outs integer not null default 0,
  pitch_h integer not null default 0,
  pitch_hr integer not null default 0,
  pitch_bb integer not null default 0,
  pitch_hbp integer not null default 0,
  pitch_k integer not null default 0,
  pitch_r integer not null default 0,
  pitch_er integer not null default 0,
  computed_at timestamptz not null default now(),
  unique (game_id, user_id)
);

create index game_player_stats_user on game_player_stats (user_id);
create index game_player_stats_team on game_player_stats (team_id);
`,
  down: `
drop table if exists game_player_stats;
`
}
