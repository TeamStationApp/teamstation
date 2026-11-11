import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  groupTile,
  leagueTint,
  personTile,
  personTint,
  seasonPicture,
  seasonTint,
  TEAM_TINTS,
  teamInitialsOf,
  teamTint
} from './teamTile'

describe('a team’s initials', function () {
  for (const [name, initials] of [
    ['Badgers (Ripken)', 'BR'],
    ['Amber Gardens', 'AG'],
    ['Badgers', 'BA'],
    ['badgers', 'BA'],
    ["St. Mary's", 'SM'],
    ['(Ripken)', 'RI'],
    ['Hawks-Eagles', 'HE'],
    ['Águilas', 'ÁG'],
    ['12U Hawks', '1H'],
    ['North Pines Royals', 'NP'],
    ['  Cedar   Lakes  ', 'CL'],
    ['A', 'A'],
    ['—', ''],
    ['', '']
  ] as const) {
    it(`reads ${JSON.stringify(name)} as ${JSON.stringify(initials)}`, function () {
      expect(teamInitialsOf(name)).equals(initials)
    })
  }
})

/** WCAG relative luminance of `#RRGGBB`. */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

describe('a team’s tile colour', function () {
  it('is the same colour every time for the same team', function () {
    expect(teamTint('tem_vShybFtE3zX82D8W')).equals(
      teamTint('tem_vShybFtE3zX82D8W')
    )
  })

  it('is always one of the 32', function () {
    for (let i = 0; i < 200; i++) {
      expect(TEAM_TINTS).includes(teamTint(`tem_${i}`))
    }
  })

  it('spreads teams across the colours', function () {
    const used = new Set<string>()
    for (let i = 0; i < 4096; i++) used.add(teamTint(`tem_sample${i}`))
    expect(used.size).equals(32)
    expect(new Set(TEAM_TINTS).size).equals(32)
  })

  it('hashes the team id, so a rename keeps it and only another id moves it', function () {
    const id = 'tem_vShybFtE3zX82D8W'
    // A team's tile, renamed: the id is unchanged, so the colour is too.
    expect(groupTile({ kind: 'team', id, name: 'Demo Hawks' }).tint).equals(
      groupTile({ kind: 'team', id, name: 'Demo Owls' }).tint
    )
    expect(teamTint(id)).equals(teamTint(id))
    const others = new Set(
      Array.from({ length: 64 }, (_, i) => teamTint(`tem_other${i}`))
    )
    expect(others.size).greaterThan(1)
  })

  it('draws a merged team on its survivor’s colour, the id its rows carry', function () {
    const survivor = 'tem_survivor'
    const merged = 'tem_mergedAway'
    expect(teamTint(merged)).not.equals(teamTint(survivor))
    // Rows of a merged team carry the survivor's id, so they draw its tile.
    expect(
      groupTile({ kind: 'team', id: survivor, name: 'Old Name' }).tint
    ).equals(teamTint(survivor))
  })
})

describe('a league’s and a season’s tile colour', function () {
  it('gives a league one colour for its id, always one of the 32', function () {
    expect(leagueTint('lea_demo')).equals(leagueTint('lea_demo'))
    for (let i = 0; i < 200; i++)
      expect(TEAM_TINTS).includes(leagueTint(`lea_${i}`))
  })

  it('gives a season its league’s colour, or its own id’s without a league', function () {
    for (let i = 0; i < 64; i++) {
      expect(seasonTint({ id: `sea_${i}`, leagueId: 'lea_demo' })).equals(
        leagueTint('lea_demo')
      )
    }
    const own = seasonTint({ id: 'sea_alone' })
    expect(seasonTint({ id: 'sea_alone', leagueId: null })).equals(own)
    expect(seasonTint({ id: 'sea_alone', leagueId: '' })).equals(own)
    expect(TEAM_TINTS).includes(own)
    const spread = new Set(
      Array.from({ length: 64 }, (_, i) => seasonTint({ id: `sea_alone${i}` }))
    )
    expect(spread.size).greaterThan(1)
  })

  it('draws a season in its own picture, else its league’s, else initials', function () {
    expect(
      seasonPicture({
        pictureUrl: 'https://images.example.test/season.png',
        leaguePictureUrl: 'https://images.example.test/league.png'
      })
    ).equals('https://images.example.test/season.png')
    expect(
      seasonPicture({
        pictureUrl: null,
        leaguePictureUrl: 'https://images.example.test/league.png'
      })
    ).equals('https://images.example.test/league.png')
    expect(
      seasonPicture({
        pictureUrl: '',
        leaguePictureUrl: 'https://images.example.test/league.png'
      })
    ).equals('https://images.example.test/league.png')
    expect(seasonPicture({ pictureUrl: null, leaguePictureUrl: '' })).equals(
      null
    )
    expect(seasonPicture({})).equals(null)
    expect(
      groupTile({
        kind: 'season',
        id: 'sea_demo',
        leagueId: 'lea_demo',
        name: 'Demo Spring'
      })
    ).deep.equals({ initials: 'DS', tint: leagueTint('lea_demo'), uri: null })
  })
})

/** The 32-bit FNV-1a the tiles use, written out again to pin the key. */
function fnv1a(key: string): number {
  let hash = 0x811c9dc5
  for (const unit of Array.from(key)) {
    hash ^= unit.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

describe('a person’s tile colour', function () {
  it('is the same every time for one account', function () {
    expect(personTint('usr_ripken')).equals(personTint('usr_ripken'))
  })

  it('hashes the account id alone, with the teams’ FNV-1a', function () {
    expect(personTint('usr_ripken')).equals(
      TEAM_TINTS[fnv1a('usr_ripken') % TEAM_TINTS.length]
    )
    expect(personTint('usr_ripken')).equals(teamTint('usr_ripken'))
  })

  it('is always one of the 32', function () {
    for (let i = 0; i < 200; i++)
      expect(TEAM_TINTS).includes(personTint(`usr_${i}`))
  })

  it('has no colour without an id: the neutral tile', function () {
    expect(personTint('')).equals(undefined)
    expect(personTint(null)).equals(undefined)
    expect(personTint(undefined)).equals(undefined)
  })

  it('draws every merged alias on the survivor’s colour, the id its rows carry', function () {
    // A merged account's rows answer with the account it became.
    const rows = ['usr_ripken_alias', 'usr_ripken'].map(() => ({
      userId: 'usr_ripken'
    }))
    expect(new Set(rows.map(row => personTint(row.userId)))).deep.equals(
      new Set([personTint('usr_ripken')])
    )
  })

  it('is the same for a reader shown the full name and one shown the short one', function () {
    // The name each reads differs, and picks only the letters.
    const full = personTile({ userId: 'usr_ripken', name: 'Cal Ripken' })
    const short = personTile({ userId: 'usr_ripken', name: 'C R' })
    expect(full.tint).equals(short.tint)
    expect(full.initials).equals('CR')
    expect(short.initials).equals('CR')
  })

  it('spreads people across the colours', function () {
    const colours = new Set(
      Array.from({ length: 128 }, (_, i) => personTint(`usr_${i}`))
    )
    expect(colours.size).at.least(20)
  })
})

describe('every tile’s colour is its id’s alone', function () {
  const named = (name: string): string[] => [`Demo ${name}`, `${name} Renamed`]

  it('keeps a team’s, a league’s, a season’s and a person’s colour through a rename', function () {
    for (const kind of ['team', 'league', 'season'] as const) {
      const [before, after] = named(kind).map(
        name => groupTile({ kind, id: `${kind}_one`, name }).tint
      )
      expect(before).not.equals(undefined)
      expect(after).equals(before)
    }
    const [before, after] = named('Ripken').map(
      name => personTile({ userId: 'usr_ripken', name }).tint
    )
    expect(after).equals(before)
  })

  it('gives two of one name and different ids their ids’ colours', function () {
    for (const kind of ['team', 'league', 'season'] as const) {
      const [one, two] = [`${kind}_one`, `${kind}_two`].map(
        id => groupTile({ kind, id, name: 'Demo Hawks' }).tint
      )
      expect(one).equals(teamTint(`${kind}_one`))
      expect(two).equals(teamTint(`${kind}_two`))
      expect(one).not.equals(two)
    }
    const [one, two] = ['usr_one', 'usr_two'].map(
      userId => personTile({ userId, name: 'Josh S' }).tint
    )
    expect(one).equals(personTint('usr_one'))
    expect(two).equals(personTint('usr_two'))
    expect(one).not.equals(two)
  })
})

describe('a group’s tile', function () {
  it('reads a team’s, a league’s and a season’s initials, with a letter for an empty name', function () {
    expect(
      groupTile({ kind: 'team', id: 'tem_a', name: ' Badgers ' })
    ).includes({ initials: 'BA', uri: null })
    expect(groupTile({ kind: 'team', id: 'tem_a', name: '' }).initials).equals(
      'T'
    )
    expect(
      groupTile({ kind: 'league', id: 'lea_a', name: '' }).initials
    ).equals('L')
    expect(
      groupTile({ kind: 'season', id: 'sea_a', name: '' }).initials
    ).equals('S')
    expect(
      groupTile({
        kind: 'league',
        id: 'lea_a',
        name: 'Demo League',
        uri: 'https://images.example.test/league.png'
      })
    ).deep.equals({
      initials: 'DL',
      tint: leagueTint('lea_a'),
      uri: 'https://images.example.test/league.png'
    })
  })

  it('has no colour before the group has an id', function () {
    for (const kind of ['team', 'league', 'season'] as const)
      expect(groupTile({ kind, id: null, name: 'Draft' }).tint).equals(
        undefined
      )
  })
})

describe('the tile palette', function () {
  it('is the thirty-two colours it has always been', function () {
    expect([...TEAM_TINTS]).deep.equals([
      '#B91C1C',
      '#C2410C',
      '#B45309',
      '#15803D',
      '#0F766E',
      '#1D4ED8',
      '#6D28D9',
      '#BE185D',
      '#991B1B',
      '#9A3412',
      '#92400E',
      '#166534',
      '#115E59',
      '#1E40AF',
      '#5B21B6',
      '#9D174D',
      '#7F1D1D',
      '#7C2D12',
      '#78350F',
      '#14532D',
      '#134E4A',
      '#1E3A8A',
      '#4C1D95',
      '#831843',
      '#9F1239',
      '#854D0E',
      '#3F6212',
      '#065F46',
      '#155E75',
      '#075985',
      '#3730A3',
      '#86198F'
    ])
  })

  it('keeps white letters readable on every colour', function () {
    for (const tint of TEAM_TINTS) {
      const contrast = (1 + 0.05) / (luminance(tint) + 0.05)
      expect(contrast, tint).at.least(4.5)
    }
  })
})
