import './backfillLinescore'
import './demo'
import './mergeTeam'
import './repairPeople'
import './seed'

import { describe, it } from 'mocha'

/**
 * These scripts connect to a database only when run as programs. Importing
 * them proves they load without connecting; `npm run typecheck` checks them
 * against the schema.
 */
describe('scoring scripts load', function () {
  it('imports the writers', function () {
    // The imports above are the check.
  })
})
