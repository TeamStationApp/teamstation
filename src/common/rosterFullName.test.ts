import { expect } from 'chai'
import { describe, it } from 'mocha'

import { rosterFullName } from './names'

describe('authorized roster names', function () {
  it('uses complete parts and preserves the legacy label when parts are incomplete', function () {
    expect(
      rosterFullName({
        id: 100,
        firstName: ' Mookie ',
        lastName: ' Betts ',
        displayName: 'Mookie B'
      })
    ).equals('Mookie Betts')
    expect(
      rosterFullName({
        id: 100,
        firstName: 'Mookie',
        lastName: null,
        displayName: ' Mookie Betts '
      })
    ).equals('Mookie Betts')
    expect(
      rosterFullName({
        id: 100,
        firstName: null,
        lastName: null,
        displayName: 'Aaron Judge'
      })
    ).equals('Aaron Judge')
    expect(
      rosterFullName({
        id: 100,
        firstName: 'Mookie',
        lastName: null,
        displayName: ''
      })
    ).equals('Mookie')
    expect(rosterFullName({ id: 100, displayName: '' })).equals('')
  })
})
