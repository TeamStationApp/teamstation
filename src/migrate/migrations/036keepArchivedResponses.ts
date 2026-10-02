import type { Migration } from '../runner'

/**
 * Re-keyed an archive of imported responses that has since left the database.
 * Kept, empty, so a database that recorded it does not look for it again.
 */
export const migration036KeepArchivedResponses: Migration = {
  name: '036keepArchivedResponses',
  up: `
select 1;
`,
  down: `
select 1;
`
}
