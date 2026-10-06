import { expect } from 'chai'
import { describe, it } from 'mocha'

import { isUndeterminedName, teamNameKey } from './teamNames'

describe('team names', function () {
  it('keys a name by itself, trimmed, spaces collapsed and any case', function () {
    expect(teamNameKey('  Harbor   Herons ')).equals('harbor herons')
    expect(teamNameKey('HARBOR\therons')).equals('harbor herons')
    expect(teamNameKey('harbor herons')).equals(teamNameKey(' Harbor Herons'))
  })

  it('keeps everything else that tells two names apart', function () {
    for (const [one, other] of [
      ['Herons 2', 'Herons'],
      ['Sea Lions (Gehrig)', 'Sea Lions'],
      ['Gulls - Livestream', 'Gulls'],
      ['Gulls (partial)', 'Gulls'],
      ["St. Mary's Hawks!", 'St Marys Hawks'],
      ['NP3 Gehrig', 'Sea Lions (Gehrig)']
    ]) {
      expect(teamNameKey(one), one).not.equals(teamNameKey(other))
    }
    expect(teamNameKey('Herons 2')).equals('herons 2')
    expect(teamNameKey('Gulls - Livestream')).equals('gulls - livestream')
  })

  it('knows a name that names no opponent yet', function () {
    for (const name of [
      'TBD',
      ' tba ',
      'TBD- 01/02/26, 9:30 AM',
      'tbd Oct 04',
      'To be determined',
      'to be decided',
      'To Be Announced (Pool B)'
    ])
      expect(isUndeterminedName(name), name).equals(true)
    for (const name of ['TBDs', 'Tbilisi', 'Rattlers', 'Team TBD', 'To be'])
      expect(isUndeterminedName(name), name).equals(false)
  })
})
