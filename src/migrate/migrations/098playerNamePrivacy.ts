import type { Migration } from '../runner'

/**
 * A league, season or team's player name privacy. Null is Default, which
 * inherits from whatever manages that level: it is not the same as choosing
 * `firstLastInitial`, which replaces what would have been inherited.
 *
 * Rolling back drops the setting, and every public name goes back to a first
 * name and last initial.
 */
const tables = ['leagues', 'seasons', 'teams']

export const migration098PlayerNamePrivacy: Migration = {
  name: '098playerNamePrivacy',
  up: tables
    .map(
      table => `
alter table ${table} add column player_name_privacy text
  constraint ${table}_player_name_privacy_check
  check (player_name_privacy in ('firstLastInitial','initialLast','initials','full'));`
    )
    .join(''),
  down: tables
    .map(table => `alter table ${table} drop column player_name_privacy;`)
    .join('\n')
}
