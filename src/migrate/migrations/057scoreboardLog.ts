import type { Migration } from '../runner'

/**
 * A game's scoreboard log: every change to its board that is not TeamStation
 * scoring, kept for good. A game's scoreboard lives in Redis and expires; the
 * scoring is replayed from its stored plays. What neither keeps is everything
 * else that moved the board: the publisher socket, the server's pitch-speed
 * hold, and the override dashboard with its Reset.
 *
 * Each row is the whole non-scoring state after one write: the publisher's
 * slot (its state and when it last reported something contested, null once a
 * reset has deleted it) and the overrides. `version` is the Redis write's own
 * version for the game, so rows from two workers order as their writes did,
 * and `at` is the server's time when the write was taken in. `actor_id` is
 * whoever's socket sent it, null for the server's own pitch-speed zero.
 *
 * Down drops the table and every row in it.
 */
export const migration057ScoreboardLog: Migration = {
  name: '057scoreboardLog',
  up: `
create table scoreboard_log (
  game_id text not null references games (id) on delete cascade,
  version bigint not null,
  at timestamptz(3) not null,
  cause text not null check (cause in ('publisher', 'speedHold', 'dashboard', 'reset')),
  actor_id bigint references users (id) on delete set null,
  publisher jsonb,
  overrides jsonb not null,
  primary key (game_id, version)
);
`,
  down: `
drop table scoreboard_log;
`
}
