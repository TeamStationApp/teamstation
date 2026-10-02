import type { Migration } from '../runner'

/**
 * Each team keeps a default lineup, taken from the starting lineup of a game
 * scored in GameStation, and each game remembers that it has given one.
 *
 * - `teams.default_lineup` is `{ lineup, fromGameId, setAt }`, or null for a
 *   team that has none yet.
 * - `games.lineup_started_at` is when the game's starting lineup was taken
 *   as its teams' defaults, or null while it has not been.
 * - `games.lineups_digest` is a sha256 of both sides' current lineups and
 *   changes after the game's last live post, or null before one.
 *
 * Down drops all three.
 */
export const migration044TeamDefaultLineup: Migration = {
  name: '044teamDefaultLineup',
  up: `
alter table teams add column default_lineup jsonb;
alter table games add column lineup_started_at timestamptz;
alter table games add column lineups_digest text;
`,
  down: `
alter table games drop column lineups_digest;
alter table games drop column lineup_started_at;
alter table teams drop column default_lineup;
`
}
