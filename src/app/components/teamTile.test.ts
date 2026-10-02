import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TEAM_TINTS, teamInitialsOf, teamTint } from './teamTile'

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

  it('is always one of the eight', function () {
    for (let i = 0; i < 200; i++) {
      expect(TEAM_TINTS).includes(teamTint(`tem_${i}`))
    }
  })

  it('spreads teams across the colours', function () {
    const used = new Set<string>()
    for (let i = 0; i < 64; i++) used.add(teamTint(`tem_sample${i}`))
    expect(used.size).at.least(6)
  })

  it('keeps white letters readable on every colour', function () {
    for (const tint of TEAM_TINTS) {
      const contrast = (1 + 0.05) / (luminance(tint) + 0.05)
      expect(contrast, tint).at.least(4.5)
    }
  })
})
