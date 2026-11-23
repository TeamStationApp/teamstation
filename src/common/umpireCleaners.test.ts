import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asUmpireNotificationSettings,
  asUmpirePeople,
  asUmpireSchedule,
  asUmpireSeasons,
  asUmpireSettings,
  asUmpireSort
} from './umpireCleaners'

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
      seasons: [{ ...season, ...tile, priority: null }]
    })
  })

  it('reads an older answer as no league picture', () => {
    expect(asUmpireSeasons({ seasons: [season] })).deep.equals({
      seasons: [
        { ...season, leagueId: '', leaguePictureUrl: null, priority: null }
      ]
    })
  })

  it('keeps the season’s place in the league order, null for none', () => {
    const [first, second] = asUmpireSeasons({
      seasons: [
        { ...season, priority: 1 },
        { ...season, priority: null }
      ]
    }).seasons
    expect([first.priority, second.priority]).deep.equals([1, null])
    expect(() =>
      asUmpireSeasons({ seasons: [{ ...season, priority: 'first' }] })
    ).throws()
  })
})

describe('umpire sort', () => {
  it('reads known keys, first first, and drops keys it does not know', () => {
    expect(asUmpireSort(['-date', 'seasonPriority'])).deep.equals([
      '-date',
      'seasonPriority'
    ])
    expect(asUmpireSort([])).deep.equals([])
    // A key a newer server added drops out; only such keys read as absent.
    expect(asUmpireSort(['venue', '-date'])).deep.equals(['-date'])
    expect(asUmpireSort(['bogus'])).equals(undefined)
    expect(() => asUmpireSort('date')).throws('Expected an umpire sort')
  })

  it('reads the settings’ default sort as given, null, or absent', () => {
    const settings = { management: true, credits: false }
    expect(
      asUmpireSettings({ ...settings, sort: ['certification'] }).sort
    ).deep.equals(['certification'])
    expect(asUmpireSettings({ ...settings, sort: null }).sort).equals(null)
    expect(asUmpireSettings(settings).sort).equals(undefined)
    expect(
      asUmpireSettings({ ...settings, sort: ['venue', 'season'] }).sort
    ).deep.equals(['season'])
    expect(asUmpireSettings({ ...settings, sort: ['none'] }).sort).equals(
      undefined
    )
    expect(() => asUmpireSettings({ ...settings, sort: 'date' })).throws()
  })

  it('reads the sort a schedule is in, absent from an older server', () => {
    const head = {
      settings: { management: true, credits: true, sort: null },
      levels: [],
      types: [],
      noteTypes: [],
      viewerId: 'usr_demo',
      isAdmin: true,
      view: 'schedule',
      creditTeams: [],
      games: []
    }
    expect(asUmpireSchedule({ ...head, sort: ['date'] }).sort).deep.equals([
      'date'
    ])
    expect(asUmpireSchedule(head).sort).equals(undefined)
    // A newer server's key, in the sort and the saved default alike, still
    // loads the schedule, which then reads as the default.
    const newer = asUmpireSchedule({
      ...head,
      settings: { ...head.settings, sort: ['venue'] },
      sort: ['venue']
    })
    expect([newer.sort, newer.settings.sort]).deep.equals([
      undefined,
      undefined
    ])
    expect(() => asUmpireSchedule({ ...head, sort: 'date' })).throws()
  })
})

describe('umpire notification settings', () => {
  const settings = {
    missingSlots: true,
    daysBefore: 7,
    signUps: false,
    withdrawals: true
  }
  it('keeps the four settings', () => {
    expect(asUmpireNotificationSettings(settings)).to.deep.equal(settings)
  })
  it('refuses one that is missing or of the wrong kind', () => {
    for (const bad of [
      { ...settings, daysBefore: '7' },
      { ...settings, signUps: 'yes' },
      { missingSlots: true, daysBefore: 7, signUps: false }
    ])
      expect(() => asUmpireNotificationSettings(bad)).throws()
  })
})
