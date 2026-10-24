import type { Migration } from '../runner'

/**
 * Every play a reset deleted, kept so nothing a scorer recorded is lost for
 * good: the game as it stood, its plays, the players added to them by hand,
 * and its tags. Deleting the game deletes its archives; deleting the user
 * who reset it keeps them.
 */
export const migration084GamePlayArchives: Migration = {
  name: '084gamePlayArchives',
  up: `create table game_play_archives (
      id text primary key,
      game_id text not null references games (id) on delete cascade,
      archived_at timestamptz not null default now(),
      actor_user_id text references users (id) on delete set null,
      reason text not null,
      home_team_id text not null,
      away_team_id text not null,
      status text not null,
      home_score integer,
      away_score integer,
      linescore jsonb,
      current_play jsonb,
      pregame jsonb,
      lineups_digest text,
      fence_distance_ft integer,
      play_generation integer not null,
      plays jsonb not null,
      players jsonb not null,
      tags jsonb not null
    );
    create index game_play_archives_game on game_play_archives (game_id);`,
  down: `drop table game_play_archives;`
}
