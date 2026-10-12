import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry } from '../../common/api'
import { withoutPrivateNames } from './scoringRosterCache'

// Permission changes remove private presentation data, preserving settings.
describe('private roster presentation cache', function () {
  it('removes name metadata without changing player settings or its input', function () {
    const row = asRosterEntry({
      userId: 100,
      shortName: 'Mookie B',
      jersey: '12',
      positions: ['P'],
      bats: 'switch',
      throws: 'left',
      isPlayer: true,
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null,
      nameDetails: {
        firstName: 'Mookie',
        lastName: 'Betts',
        displayName: 'Mookie Betts'
      }
    })
    const basic = withoutPrivateNames([row])
    expect(basic[0].nameDetails).equals(undefined)
    expect(basic[0]).includes({ jersey: '12', bats: 'switch', throws: 'left' })
    expect(basic[0].positions).deep.equals(['P'])
    expect(row.nameDetails).not.equals(undefined)
  })
})
