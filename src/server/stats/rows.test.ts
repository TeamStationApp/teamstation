import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import { mintUserId } from '../../common/mintUserId'
import { shortNames } from '../../common/names'
import { statsDatabase } from '../../test/statsDatabase'
import { statRows } from './rows'

describe('stat rows', function () {
  this.timeout(60000)
  const fixture = statsDatabase('rows')
  // A player imported once with no name, and later merged into their own row.
  const placeholder = mintUserId(() => false)

  before(async function () {
    const { db, ids } = fixture
    await db
      .updateTable('users')
      .set({
        first_name: 'Ted',
        last_name: 'Williams',
        display_name: 'Ted Williams'
      })
      .where('id', '=', ids[0])
      .execute()
    await db
      .insertInto('users')
      .values({
        id: placeholder.userId,
        legacyId: placeholder.legacyId,
        display_name: 'Unknown player',
        merged_into: ids[0]
      })
      .execute()
    await db
      .insertInto('game_player_stats')
      .values([
        // Written first, under the row that has since closed.
        {
          id: 'gps_placeholder',
          game_id: 'gam_demo',
          team_id: 'tem_home',
          user_id: placeholder.userId,
          pa: 2,
          ab: 2,
          h: 1
        },
        {
          id: 'gps_own',
          game_id: 'gam_demo',
          team_id: 'tem_home',
          user_id: ids[0],
          pa: 3,
          ab: 3,
          h: 2
        },
        {
          id: 'gps_other',
          game_id: 'gam_demo',
          team_id: 'tem_home',
          user_id: ids[1],
          pa: 1,
          ab: 1
        }
      ])
      .execute()
  })

  it('names a row written under a merged-away user as the person it became', async function () {
    const { db, ids } = fixture
    const rows = await statRows(db, { teamId: 'tem_home' })
    const named = rows
      .map(row => [row.userId, row.firstName, row.lastName, row.displayName])
      .sort((a, b) => String(a[3]).localeCompare(String(b[3])))
    expect(named).deep.equals([
      [ids[1], null, null, 'Demo Player 1'],
      [ids[0], 'Ted', 'Williams', 'Ted Williams'],
      [ids[0], 'Ted', 'Williams', 'Ted Williams']
    ])
    // The name a team's table shows, which is the first of a person's rows.
    const names = shortNames(
      rows.map(row => ({
        id: row.userId,
        firstName: row.firstName,
        lastName: row.lastName,
        displayName: row.displayName
      }))
    )
    expect(names.get(ids[0])).equals('Ted W')
  })
})
