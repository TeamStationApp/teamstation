import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asUmpirePeople, asUmpireSeasons } from './umpireCleaners'

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
    ).deep.equals({
      people: [{ ...person, affiliations: line }]
    })
  })

  it('reads a missing line as none', () => {
    expect(asUmpirePeople({ people: [person] })).deep.equals({
      people: [{ ...person, affiliations: '' }]
    })
  })

  it('carries no public label, even from a server that sends one', () => {
    expect(
      asUmpirePeople({ people: [{ ...person, publicName: 'M B' }] }).people[0]
    ).not.have.property('publicName')
  })

  it('still refuses a line that is not text', () => {
    expect(() =>
      asUmpirePeople({ people: [{ ...person, affiliations: 7 }] })
    ).throws()
  })
})

describe('umpire seasons', () => {
  const season = {
    id: 'sea_demo',
    name: 'Demo Spring',
    logoUrl: null,
    requirement: null
  }

  it('keeps the league and its picture a season is drawn with', () => {
    const tile = {
      leagueId: 'lea_demo',
      leaguePictureUrl: 'https://images.example.test/league.png'
    }
    expect(asUmpireSeasons({ seasons: [{ ...season, ...tile }] })).deep.equals({
      seasons: [{ ...season, ...tile }]
    })
  })

  it('reads an older answer as no league picture', () => {
    expect(asUmpireSeasons({ seasons: [season] })).deep.equals({
      seasons: [{ ...season, leagueId: '', leaguePictureUrl: null }]
    })
  })
})
