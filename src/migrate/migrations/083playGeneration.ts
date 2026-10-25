import type { Migration } from '../runner'

/**
 * Which set of plays a game holds: 0 for the plays it was first scored with,
 * and one more each time a reset deletes them all. A device that opened the
 * game on another generation is refused, so it never writes plays meant
 * for the game before its reset.
 */
export const migration083PlayGeneration: Migration = {
  name: '083playGeneration',
  up: `alter table games add column play_generation integer not null default 0;`,
  down: `alter table games drop column play_generation;`
}
