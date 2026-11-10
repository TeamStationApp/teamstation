import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry, type RosterEntry } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { withoutPrivateNames, withPublicNames } from './scoringRosterCache'

// Permission changes remove private presentation data, preserving settings.
describe('private roster presentation cache', function () {
  it('removes name metadata without changing player settings or its input', function () {
    const row = asRosterEntry({
      userId: userIdOfGumbo(100),
      gumboId: 100,
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
  const entry = (named: Record<string, unknown>): RosterEntry =>
    asRosterEntry({
      userId: userIdOfGumbo(100),
      gumboId: 100,
      jersey: '12',
      positions: ['P'],
      isPlayer: true,
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null,
      ...named
    })
  // The server names a reader's players in full in `shortName`, with the
  // public label beside it.
  const full = entry({
    shortName: 'Mookie Betts',
    nameFormat: 'full',
    compactName: 'Mookie B',
    nameDetails: {
      firstName: 'Mookie',
      lastName: 'Betts',
      displayName: 'Mookie Betts'
    }
  })
  it('keeps the name a fresh read gave its reader', function () {
    const [read] = withoutPrivateNames([full])
    expect(read).includes({
      shortName: 'Mookie Betts',
      nameFormat: 'full',
      compactName: 'Mookie B'
    })
    expect(read.nameDetails).equals(undefined)
  })
  it('draws held rows by the public label once their reader may not read them', function () {
    const formatted = entry({
      shortName: 'Mookie Betts',
      nameFormat: 'full',
      compactName: 'M. Betts',
      compactFormat: 'initialLast'
    })
    const plain = entry({ shortName: 'Mike T' })
    const [held, initial, short] = withPublicNames([full, formatted, plain])
    expect(held.shortName).equals('Mookie B')
    expect(held.nameFormat).equals(undefined)
    expect(held.compactName).equals(undefined)
    expect(held.nameDetails).equals(undefined)
    expect(held).includes({ jersey: '12' })
    expect(initial).includes({
      shortName: 'M. Betts',
      nameFormat: 'initialLast'
    })
    expect(initial.compactFormat).equals(undefined)
    expect(short).deep.equals({ ...plain, nameDetails: undefined })
    expect(full.shortName).equals('Mookie Betts')
  })
})
