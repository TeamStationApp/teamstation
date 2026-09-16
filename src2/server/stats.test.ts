import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  addLines,
  battingLines,
  battingRates,
  emptyLine,
  type StatEvent
} from './stats'

const ROBIN = 'usr_robin'
const SAM = 'usr_sam'
const TEAM = 'tem_one'

const at = (eventType: string, rbi = 0, userId = ROBIN): StatEvent => ({
  batterUserId: userId,
  teamId: TEAM,
  eventType,
  rbi
})

describe('stats', function () {
  it('counts a plate appearance for every time up', function () {
    const [line] = battingLines([at('single'), at('walk'), at('strikeout')])
    expect(line.pa).equals(3)
  })

  it('leaves walks, hit-by-pitch and sacrifices out of at-bats', function () {
    const [line] = battingLines([
      at('single'),
      at('walk'),
      at('hit_by_pitch'),
      at('sac_fly'),
      at('strikeout')
    ])
    expect(line.pa).equals(5)
    expect(line.ab).equals(2)
    expect(line.bb).equals(1)
    expect(line.hbp).equals(1)
  })

  it('counts hits by kind', function () {
    const [line] = battingLines([
      at('single'),
      at('single'),
      at('double'),
      at('triple'),
      at('home_run'),
      at('field_out')
    ])
    expect(line.h).equals(5)
    expect(line.singles).equals(2)
    expect(line.doubles).equals(1)
    expect(line.triples).equals(1)
    expect(line.hr).equals(1)
  })

  it('ignores things that are not a plate appearance', function () {
    const lines = battingLines([at('stolen_base'), at('wild_pitch')])
    expect(lines).deep.equals([])
  })

  it('ignores a play with nobody named', function () {
    const lines = battingLines([
      { batterUserId: null, teamId: TEAM, eventType: 'single', rbi: 0 }
    ])
    expect(lines).deep.equals([])
  })

  it('keeps players apart, and sorts by who batted most', function () {
    const lines = battingLines([
      at('single', 0, ROBIN),
      at('single', 0, ROBIN),
      at('walk', 0, SAM)
    ])
    expect(lines.map(line => line.userId)).deep.equals([ROBIN, SAM])
    expect(lines[0].pa).equals(2)
    expect(lines[1].pa).equals(1)
  })

  it('keeps one player apart on two teams', function () {
    const lines = battingLines([
      at('single'),
      { batterUserId: ROBIN, teamId: 'tem_two', eventType: 'double', rbi: 0 }
    ])
    expect(lines.length).equals(2)
    const teams = lines
      .map(line => line.teamId ?? '')
      .sort((a, b) => a.localeCompare(b))
    expect(teams).deep.equals(['tem_one', 'tem_two'])
  })

  it('works out the usual rates from the counts', function () {
    const line = {
      ...emptyLine(ROBIN, TEAM),
      pa: 5,
      ab: 4,
      h: 2,
      singles: 1,
      doubles: 1,
      bb: 1
    }
    const rates = battingRates(line)
    expect(rates.avg).equals(0.5)
    // Three total bases over four at-bats.
    expect(rates.slg).equals(0.75)
    // Three times on base out of five chances.
    expect(rates.obp).equals(0.6)
    expect(rates.ops).equals(1.35)
  })

  it('has no average for a player who has never batted', function () {
    const rates = battingRates(emptyLine(ROBIN, TEAM))
    // Not zero: no at-bats is not the same as batting .000.
    expect(rates.avg).equals(undefined)
    expect(rates.obp).equals(undefined)
    expect(rates.ops).equals(undefined)
  })

  it('gives a walk an on-base percentage but still no average', function () {
    const [line] = battingLines([at('walk')])
    const rates = battingRates(line)
    expect(rates.avg).equals(undefined)
    expect(rates.obp).equals(1)
  })

  it('adds seasons together for a career', function () {
    const spring = { ...emptyLine(ROBIN, TEAM), pa: 10, ab: 8, h: 3, hr: 1 }
    const fall = { ...emptyLine(ROBIN, TEAM), pa: 12, ab: 10, h: 4, hr: 2 }
    const career = addLines(spring, fall)
    expect(career.pa).equals(22)
    expect(career.ab).equals(18)
    expect(career.h).equals(7)
    expect(career.hr).equals(3)
  })

  it('drops the team when a career spans two of them', function () {
    const one = { ...emptyLine(ROBIN, 'tem_one'), pa: 1 }
    const two = { ...emptyLine(ROBIN, 'tem_two'), pa: 1 }
    expect(addLines(one, two).teamId).equals(null)
  })

  it('credits RBI as the plays gave them', function () {
    const [line] = battingLines([at('single', 2), at('home_run', 1)])
    expect(line.rbi).equals(3)
  })
})
