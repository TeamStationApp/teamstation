import { expect } from 'chai'
import { describe, it } from 'mocha'

import { capacityCause } from './capacity'
import { buildContext, type RunContext } from './context'
import {
  equalLine,
  floorTargets,
  lowerTargets,
  settleTargets,
  startingTargets,
  totalsLine,
  unmetLines
} from './counts'
import { field, fixedGame, hoursOn, input, season } from './fixtures.test'
import { fairnessRows } from './options'
import type { EngineInput, FixedGame, UnmetConstraint } from './types'

const saturday = (start: string, end: string): ReturnType<typeof hoursOn> =>
  hoursOn([6], start, end)

/** A run on Saturdays in March only, with the hours given. */
function march(
  start: string,
  end: string,
  settings: Parameters<typeof season>[0] = {},
  fixed: FixedGame[] = []
): EngineInput {
  const hours = saturday(start, end)
  return input({
    seasons: [
      season({
        endsOn: '2027-03-31',
        windows: [{ from: '2027-03-01', hours }],
        ...settings
      })
    ],
    fields: [field({ availability: { ...field().availability, hours } })],
    fixed
  })
}

function settle(run: EngineInput): {
  context: RunContext
  targets: Map<string, { regular: number; exhibition: number }>
  unmet: UnmetConstraint[]
  totals: number[]
} {
  const context = buildContext(run)
  const { targets, placement } = settleTargets(context, 3)
  return {
    context,
    targets,
    unmet: unmetLines(context, targets, placement, (of, kind, requested) =>
      capacityCause(context, of, kind, requested)
    ),
    totals: fairnessRows(context, placement)
      .filter(row => !row.exhibitionTeam)
      .map(row => row.regularGames)
  }
}

// Two fixed games for the Hawks, on Sundays and on no field.
const HAWKS_FIXED = [
  fixedGame('g1', 'tem_hawks', 'tem_owls', '2027-03-07T15:00:00.000Z', 90, {
    fieldId: null
  }),
  fixedGame('g2', 'tem_foxes', 'tem_hawks', '2027-03-14T15:00:00.000Z', 90, {
    fieldId: null
  })
]

describe('settleTargets', () => {
  it('lowers every team’s target equally and reports it', () => {
    // Four Saturdays of six games can't hold seven teams × 8 games.
    const { targets, unmet, totals } = settle(
      march('08:00', '18:00', { regularGames: 8 })
    )
    expect(targets.get('sea_demo')).deep.equals({ regular: 4, exhibition: 1 })
    expect(new Set(totals)).deep.equals(new Set([4]))
    expect(unmet).deep.equals([
      {
        seasonId: 'sea_demo',
        message: 'every team gets 4 of the 8 requested regular-season games',
        cause: 'not enough 50/70 field time to give every team 8 games'
      }
    ])
  }).timeout(30_000)

  it('lowers regular games first, then exhibition games', () => {
    const { targets, unmet } = settle(
      march(
        '08:00',
        '18:00',
        { regularGames: 4, endsOn: '2027-03-06' },
        HAWKS_FIXED
      )
    )
    expect(targets.get('sea_demo')).deep.equals({ regular: 2, exhibition: 0 })
    expect(unmet.map(line => line.message)).deep.equals([
      'every team gets 2 of the 4 requested regular-season games',
      'every team gets 0 of the 1 requested exhibition game'
    ])
    expect(unmet[1].cause).equals(
      'not enough 50/70 field time to give every team 1 exhibition game'
    )
  }).timeout(30_000)

  it('stops at the highest fixed count, then clamps needs and reports the totals team by team', () => {
    // One game fits; the Hawks already have two.
    const { targets, unmet } = settle(
      march(
        '08:00',
        '11:00',
        { regularGames: 2, exhibitionGames: 0, endsOn: '2027-03-06' },
        HAWKS_FIXED
      )
    )
    expect(targets.get('sea_demo')).deep.equals({ regular: 2, exhibition: 0 })
    expect(unmet).length(1)
    expect(unmet[0].message).match(
      /^Demo \w+ gets 0 of 2 regular-season games; .*Demo Hawks gets 2 of 2; the others get 1 of 2$/
    )
    expect(unmet[0].cause).equals(
      'not enough 50/70 field time to give every team 2 games'
    )
  }).timeout(30_000)

  it('lowers again when a search leaves games unplaced', () => {
    // Three teams who never play twice a day: one game a Saturday at most.
    const run = input({
      seasons: [
        season(
          {
            endsOn: '2027-03-13',
            regularGames: 2,
            exhibitionGames: 0,
            doubleheaders: 'never',
            windows: [{ from: '2027-03-01', hours: saturday('08:00', '18:00') }]
          },
          {
            participants: ['tem_hawks', 'tem_owls', 'tem_foxes'],
            exhibitionTeams: []
          }
        )
      ],
      fixed: [
        fixedGame('g1', 'tem_hawks', 'tem_owls', '2027-03-06T15:00:00.000Z')
      ]
    })
    const context = buildContext(run)
    expect(startingTargets(context, context.seasons[0], 3)).deep.equals({
      regular: 2,
      exhibition: 0
    })
    const { targets, unmet } = settle(run)
    expect(targets.get('sea_demo')).deep.equals({ regular: 1, exhibition: 0 })
    expect(unmet[0].message).equals(
      'Demo Foxes gets 0 of 2 regular-season games; the others get 1 of 2'
    )
  }).timeout(30_000)

  it('leaves a season that fits alone', () => {
    const { targets, unmet } = settle(
      march('08:00', '18:00', { regularGames: 2 })
    )
    expect(targets.get('sea_demo')).deep.equals({ regular: 2, exhibition: 1 })
    expect(unmet).deep.equals([])
  }).timeout(30_000)
})

describe('target helpers', () => {
  it('floors at the highest fixed count, never above the request', () => {
    const context = buildContext(
      march('08:00', '18:00', { regularGames: 1 }, [
        ...HAWKS_FIXED,
        fixedGame(
          'g3',
          'tem_hawks',
          'tem_otters',
          '2027-03-21T15:00:00.000Z',
          90,
          {
            exhibition: true,
            fieldId: null
          }
        )
      ])
    )
    expect(floorTargets(context.seasons[0])).deep.equals({
      regular: 1,
      exhibition: 1
    })
  }).timeout(30_000)

  it('passes over a regular target that would leave one team short', () => {
    const context = buildContext(march('08:00', '18:00', { regularGames: 8 }))
    const targets = { regular: 8, exhibition: 1 }
    expect(lowerTargets(context, context.seasons[0], targets)).equals(true)
    expect(targets).deep.equals({ regular: 6, exhibition: 1 })
    const odd = buildContext(march('08:00', '18:00', { regularGames: 3 }))
    const asked = { regular: 3, exhibition: 1 }
    lowerTargets(odd, odd.seasons[0], asked)
    expect(asked).deep.equals({ regular: 2, exhibition: 1 })
    lowerTargets(odd, odd.seasons[0], asked)
    expect(asked).deep.equals({ regular: 1, exhibition: 1 })
  }).timeout(30_000)

  it('goes to exhibition games once regular ones are at the floor, then stops', () => {
    const context = buildContext(march('08:00', '18:00'))
    const targets = { regular: 0, exhibition: 1 }
    expect(lowerTargets(context, context.seasons[0], targets)).equals(true)
    expect(targets).deep.equals({ regular: 0, exhibition: 0 })
    expect(lowerTargets(context, context.seasons[0], targets)).equals(false)
  }).timeout(30_000)

  it('writes the equal and the team-by-team lines', () => {
    expect(equalLine('regular', 11, 12)).equals(
      'every team gets 11 of the 12 requested regular-season games'
    )
    expect(equalLine('exhibition', 1, 2)).equals(
      'every team gets 1 of the 2 requested exhibition games'
    )
    expect(
      totalsLine(
        'regular',
        [
          { name: 'Demo Hawks', total: 9 },
          { name: 'Demo Owls', total: 10 },
          { name: 'Demo Foxes', total: 10 }
        ],
        12
      )
    ).equals(
      'Demo Hawks gets 9 of 12 regular-season games; the others get 10 of 12'
    )
    expect(
      totalsLine(
        'exhibition',
        [
          { name: 'Demo Hawks', total: 1 },
          { name: 'Demo Owls', total: 2 }
        ],
        2
      )
    ).equals('Demo Hawks gets 1 of 2 exhibition games; Demo Owls gets 2 of 2')
    expect(totalsLine('regular', [{ name: 'Demo Hawks', total: 3 }], 4)).equals(
      'every team gets 3 of the 4 requested regular-season games'
    )
    expect(totalsLine('regular', [], 4)).equals(
      'every team gets 0 of the 4 requested regular-season games'
    )
  }).timeout(30_000)
})
