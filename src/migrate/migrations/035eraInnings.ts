import type { Migration } from '../runner'

/**
 * The innings an ERA divides by: a season's own `era_innings`, else its
 * league's, else six.
 *
 * An ERA is earned runs per game, and a game here is six innings, not nine.
 * The figure belongs to the league's rules, so it is stored rather than
 * measured from how long a season's games ran, which a few rain-shortened or
 * time-limited games can swing. No route or screen writes either column yet:
 * both are set by hand in the database, and a season with no figure of its own
 * and none on its league divides by six.
 *
 * Each season's `innings_per_game` becomes its `era_innings`.
 */
export const migration035EraInnings: Migration = {
  name: '035eraInnings',
  up: `
alter table seasons rename column innings_per_game to era_innings;
alter table seasons rename constraint seasons_innings_per_game_check to seasons_era_innings_check;
alter table leagues
  add column era_innings integer check (era_innings between 1 and 15);
`,
  down: `
alter table leagues drop column if exists era_innings;
alter table seasons rename constraint seasons_era_innings_check to seasons_innings_per_game_check;
alter table seasons rename column era_innings to innings_per_game;
`
}
