import type { Migration } from '../runner'

/**
 * Shortened the full names in stored play wording, reading them from an
 * archive of imported rosters that has since left the database. Kept, empty,
 * so a database that recorded it does not look for it again.
 */
export const migration025ShortNamesInDescriptions: Migration = {
  name: '025shortNamesInDescriptions',
  up: `
select 1;
`,
  down: `
select 1;
`
}
