import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asUmpirePeople } from './umpireCleaners'

describe('umpire people', () => {
  const person = {
    id: 'usr_demo',
    name: 'Mookie B',
    avatarUrl: null,
    certifications: [{ levelId: 'lvl_demo', typeId: 'typ_demo', enabled: true }]
  }

  it('keeps the affiliation line the server sends', () => {
    const line = 'Guardian of Tim R · Demo Eagles'
    expect(
      asUmpirePeople({ people: [{ ...person, affiliations: line }] })
    ).deep.equals({ people: [{ ...person, affiliations: line }] })
  })

  it('reads a missing line as none', () => {
    expect(asUmpirePeople({ people: [person] })).deep.equals({
      people: [{ ...person, affiliations: '' }]
    })
  })

  it('still refuses a line that is not text', () => {
    expect(() =>
      asUmpirePeople({ people: [{ ...person, affiliations: 7 }] })
    ).throws()
  })
})
