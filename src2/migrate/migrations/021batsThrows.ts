import type { Migration } from '../runner'

/**
 * Which side a player bats from, and which hand they throw with.
 *
 * The imported rosters have carried this all along, and the importer has been
 * dropping it on the floor. Measured over four real
 * teams: 42 of 59 players have a batting side and 41 a throwing hand, and the
 * rest are simply blank because nobody filled them in.
 *
 * Blank is a real answer and is stored as null. A player page draws the line
 * only when there is something to draw: `B: —` is a claim that somebody looked
 * and found nothing, which is not what an empty column means.
 *
 * `bats_source` is what keeps a re-import from stamping on a coach's
 * correction. An import writes only where the source is null or `import`;
 * anything a person set by hand is left alone.
 *
 * `switch` has a home here although no switch hitter has turned up in the data
 * yet — the source's vocabulary is not documented, so an import treats
 * anything that is not `left` or `right` as unknown rather than guessing that
 * it maps to this.
 */
export const migration021BatsThrows: Migration = {
  name: '021batsThrows',
  up: `
alter table users
  add column bats text check (bats in ('left', 'right', 'switch')),
  add column throws text check (throws in ('left', 'right')),
  add column bats_source text check (bats_source in ('import', 'manual'));
`,
  down: `
alter table users
  drop column if exists bats,
  drop column if exists throws,
  drop column if exists bats_source;
`
}
