import type { Migration } from '../runner'

/**
 * How many innings a game in this season is meant to run.
 *
 * It exists for one figure: an ERA is earned runs per *game*, and a game is
 * nine innings in the major leagues and six in this league. The published
 * season stats divide by the league's own regulation length — for all six
 * teams held, `ERA × IP ÷ ER` comes out at exactly 6.0000.
 *
 * Derived rather than configured: the regulation length of a season is the
 * number of innings most of its games actually ran, which the line scores
 * already say. Over the 71 games we hold with a line score, 49 ran six innings,
 * 12 were short and 2 went extra — so the figure is 6, and it agrees with the
 * published divisor to four decimal places.
 *
 * Null until something works it out, and an ERA is not shown without it. A
 * divisor we guessed would make every ERA on the site wrong by a third.
 */
export const migration024SeasonInnings: Migration = {
  name: '024seasonInnings',
  up: `
alter table seasons
  add column innings_per_game integer check (innings_per_game between 1 and 15);
`,
  down: `
alter table seasons
  drop column if exists innings_per_game;
`
}
