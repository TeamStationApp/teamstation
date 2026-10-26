import { expect } from 'chai'
import { describe, it } from 'mocha'

import { buildContext } from '../../common/autoScheduler/context'
import { Occupancy } from '../../common/autoScheduler/feasibility'
import {
  field as engineField,
  fixedGame,
  hoursOn,
  input,
  present,
  season as engineSeason
} from '../../common/autoScheduler/fixtures.test'
import type { FieldSize } from '../../common/venues'
import { type Holding, type RuleContext, ruleProblem } from './rules'

const MINUTE = 60 * 1000
const at = (time: string): number => Date.parse(`2027-03-06T${time}:00Z`)

const context = (others: Holding[]): RuleContext => ({
  fields: new Map([
    [
      'fld_one',
      {
        name: 'Field 1',
        venueName: 'Demo Park',
        sizes: ['50/70'],
        availability: {
          startsOn: null,
          endsOn: null,
          // 2027-03-06 is a Saturday, open all day.
          hours: [{ weekday: 6, start: '00:00', end: '24:00' }],
          blackouts: [],
          timezone: 'UTC'
        },
        switchMs: 0
      }
    ]
  ]),
  seasons: new Map([
    ['sea_a', { bufferMinutes: 30, doubleheaders: 'allowed' }],
    ['sea_b', { bufferMinutes: 0, doubleheaders: 'allowed' }]
  ]),
  others
})

const game = (
  key: string,
  seasonId: string,
  start: string,
  end: string,
  teamIds: string[]
): Holding & { fieldId: string; size: FieldSize; seasonId: string } => ({
  key,
  fieldId: 'fld_one',
  size: '50/70',
  teamIds,
  seasonId,
  start: at(start),
  end: at(end)
})

/** The rule's answer on field spacing alone, open hours aside. */
const tooClose = (
  checked: ReturnType<typeof game>,
  other: Holding
): boolean => {
  const problem = ruleProblem(checked, context([other]))
  return problem?.startsWith('Another game on') === true
}

describe('the scheduler’s hard rules', () => {
  it('spaces games of two seasons on one field by the later game’s buffer, as the engine does', () => {
    // Season A asks 30 minutes between games, season B none.
    const a = game('a', 'sea_a', '10:30', '12:00', ['tem_one', 'tem_two'])
    const bRightAfter = game('b', 'sea_b', '12:00', '13:30', [
      'tem_three',
      'tem_four'
    ])
    // B comes later and asks nothing: both checks agree it fits.
    expect(tooClose(a, bRightAfter)).equals(false)
    expect(tooClose(bRightAfter, a)).equals(false)
    // A comes later, 10 minutes after B: its 30 minutes are not kept.
    const bBefore = game('b', 'sea_b', '08:30', '10:20', [
      'tem_three',
      'tem_four'
    ])
    expect(tooClose(a, bBefore)).equals(true)
    expect(tooClose(bBefore, a)).equals(true)
    // 30 minutes after B, it fits either way round.
    const bEarlier = { ...bBefore, end: a.start - 30 * MINUTE }
    expect(tooClose(a, bEarlier)).equals(false)
    expect(tooClose(bEarlier, a)).equals(false)
  })

  it('takes the checked game’s buffer for a booking outside the run', () => {
    const a = game('a', 'sea_a', '10:30', '12:00', ['tem_one', 'tem_two'])
    const outside: Holding = {
      key: 'bkg_outside',
      fieldId: 'fld_one',
      size: '50/70',
      teamIds: [],
      seasonId: null,
      start: at('12:20'),
      end: at('13:30')
    }
    expect(tooClose(a, outside)).equals(true)
    expect(tooClose(a, { ...outside, start: at('12:30') })).equals(false)
  })

  it('reads a season’s no-doubleheaders day as the field’s local day', () => {
    // Field 1 in New York, open all of Friday and Saturday.
    const local = (): RuleContext => {
      const base = context([])
      const one = base.fields.get('fld_one')!
      return {
        ...base,
        fields: new Map([
          [
            'fld_one',
            {
              ...one,
              availability: {
                ...one.availability,
                hours: [5, 6].map(weekday => ({
                  weekday,
                  start: '00:00',
                  end: '24:00'
                })),
                timezone: 'America/New_York'
              }
            }
          ]
        ]),
        seasons: new Map([
          ['sea_a', { bufferMinutes: 0, doubleheaders: 'never' }]
        ])
      }
    }
    // 01:00Z on Saturday is Friday evening in New York, a day apart from a
    // Saturday afternoon game there, though both are Saturday in UTC.
    const friday = game('a', 'sea_a', '01:00', '02:30', ['tem_one', 'tem_two'])
    const saturday = game('b', 'sea_a', '18:00', '19:30', [
      'tem_one',
      'tem_three'
    ])
    expect(ruleProblem(saturday, { ...local(), others: [friday] })).equals(null)
    const later = game('c', 'sea_a', '21:00', '22:30', ['tem_one', 'tem_four'])
    expect(ruleProblem(later, { ...local(), others: [saturday] })).equals(
      'This season has no doubleheaders, and a team already plays that day.'
    )
  })

  it('reads each game’s no-doubleheaders day in its own field’s zone, as the engine does', () => {
    // A Los Angeles field and a New York field, both open all of Friday and
    // Saturday, in a season with no doubleheaders.
    const allDay = hoursOn([5, 6], '00:00', '24:00')
    const fieldIn = (
      id: string,
      name: string,
      timezone: string
    ): ReturnType<typeof engineField> =>
      engineField({
        id,
        name,
        availability: {
          ...engineField().availability,
          hours: allDay,
          timezone
        }
      })
    const fields = [
      fieldIn('fld_la', 'LA Field', 'America/Los_Angeles'),
      fieldIn('fld_ny', 'NY Field', 'America/New_York')
    ]
    const settings = {
      doubleheaders: 'never' as const,
      bufferMinutes: 0,
      windows: [{ from: '2027-03-01', hours: allDay }]
    }
    // 9:30 PM Friday in Los Angeles, and 9 AM Saturday in New York: different
    // days where each is played, though the first is 00:30 Saturday in New
    // York.
    const lateInLa = fixedGame(
      'gam_la',
      'tem_hawks',
      'tem_owls',
      '2027-03-06T05:30:00Z',
      90,
      { fieldId: 'fld_la' }
    )
    const morningInNy = Date.parse('2027-03-06T14:00:00Z')

    // The engine counts them on different days, so the New York slot fits.
    const engine = buildContext(
      input({
        seasons: [engineSeason(settings)],
        fields,
        fixed: [lateInLa]
      })
    )
    const [first] = engine.seasons
    const slot = present(
      first.slots.find(
        each => each.fieldId === 'fld_ny' && each.start === morningInNy
      )
    )
    expect(
      new Occupancy(engine).fits(first, 'tem_hawks', 'tem_foxes', slot)
    ).equals(true)

    // The hard rules agree.
    const rules: RuleContext = {
      fields: new Map(
        fields.map(each => [
          each.id,
          {
            name: each.name,
            venueName: each.venueName,
            sizes: each.sizes,
            availability: each.availability,
            switchMs: 0
          }
        ])
      ),
      seasons: new Map([
        [first.season.id, { bufferMinutes: 0, doubleheaders: 'never' }]
      ]),
      others: [
        {
          key: lateInLa.key,
          fieldId: lateInLa.fieldId,
          size: lateInLa.size,
          teamIds: [lateInLa.homeTeamId, lateInLa.awayTeamId],
          seasonId: lateInLa.seasonId,
          start: lateInLa.start,
          end: lateInLa.end
        }
      ]
    }
    const checked = {
      key: 'gam_ny',
      fieldId: 'fld_ny',
      size: '50/70' as const,
      teamIds: ['tem_hawks', 'tem_foxes'],
      seasonId: first.season.id,
      start: morningInNy,
      end: morningInNy + 90 * MINUTE
    }
    expect(ruleProblem(checked, rules)).equals(null)

    // A game on a field outside the run is read in the zone of the run's
    // first field of the season's size, as the engine reads it: Los Angeles
    // here, so the same instant off the run's fields is Friday too.
    const offRun = { ...rules.others[0], fieldId: 'fld_elsewhere' }
    expect(first.zoneOf('fld_elsewhere')).equals('America/Los_Angeles')
    expect(ruleProblem(checked, { ...rules, others: [offRun] })).equals(null)
    // A Saturday morning game in Los Angeles is the same day as New York's.
    const saturdayInLa = {
      ...rules.others[0],
      start: Date.parse('2027-03-06T16:00:00Z'),
      end: Date.parse('2027-03-06T17:30:00Z')
    }
    expect(ruleProblem(checked, { ...rules, others: [saturdayInLa] })).equals(
      'This season has no doubleheaders, and a team already plays that day.'
    )
  })
})
