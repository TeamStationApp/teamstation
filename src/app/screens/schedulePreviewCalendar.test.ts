import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { PlannedGame } from '../../common/autoScheduler/types'
import {
  ALL_GAMES,
  calendarWeeks,
  dayHeader,
  fieldLabels,
  fieldPillLabel,
  filterChoices,
  filteredGames,
  firstDayOf,
  mondayOnOrBefore,
  normalizeFilter,
  sameFilter,
  weekAnchor,
  weekTitle
} from './schedulePreviewCalendar'

const PREVIEW = {
  teams: [
    { id: 'tem_hawks', name: 'Demo Hawks' },
    { id: 'tem_owls', name: 'Demo Owls' },
    { id: 'tem_foxes', name: 'Demo Foxes' },
    { id: 'tem_otters', name: 'Demo Otters' },
    { id: 'tem_bears', name: 'Demo Bears' }
  ],
  seasons: [
    {
      id: 'sea_spring',
      name: 'Spring',
      timezone: 'UTC',
      gameMinutes: 90,
      startsOn: '2027-03-07',
      participants: ['tem_hawks', 'tem_owls', 'tem_foxes'],
      exhibitionTeams: ['tem_otters']
    },
    {
      id: 'sea_summer',
      name: 'Summer',
      timezone: 'UTC',
      gameMinutes: 90,
      startsOn: '2027-06-01',
      participants: ['tem_bears', 'tem_hawks'],
      exhibitionTeams: []
    }
  ],
  fields: [
    {
      id: 'fld_tb1',
      name: 'TB1',
      venueName: 'Morley Field Sports Complex',
      sizes: ['46/60' as const],
      timezone: 'America/Los_Angeles'
    },
    {
      id: 'fld_one',
      name: 'Field 1',
      venueName: 'Balboa',
      sizes: ['46/60' as const],
      timezone: 'America/Los_Angeles'
    }
  ]
}

let next = 0
function game(
  startAt: string,
  changes: Partial<PlannedGame> = {}
): PlannedGame {
  next++
  return {
    key: `g${String(next).padStart(3, '0')}`,
    seasonId: 'sea_spring',
    homeTeamId: 'tem_hawks',
    awayTeamId: 'tem_owls',
    exhibition: false,
    fieldId: 'fld_tb1',
    size: '46/60',
    startAt,
    endAt: new Date(Date.parse(startAt) + 90 * 60000).toISOString(),
    ...changes
  }
}

const UTC = { zone: 'UTC' }

describe('the schedule preview calendar', () => {
  it('names a field by its shortened venue and its own name', () => {
    expect(fieldPillLabel(PREVIEW.fields[0])).equals('MFS/TB1')
    // A venue of ten characters or fewer stays whole.
    expect(fieldPillLabel(PREVIEW.fields[1])).equals('BALBOA/Field 1')
    expect(fieldPillLabel({ venueName: 'Park', name: 'B' })).not.includes(' /')
  })

  it('names two fields whose short labels would match in full', () => {
    const fields = [
      { id: 'a', name: 'Field 1', venueName: 'Morley Field Sports Complex' },
      { id: 'b', name: 'Field 1', venueName: 'Morley Field Softball Complex' },
      { id: 'c', name: 'TB1', venueName: 'Morley Field Sports Complex' },
      { id: 'd', name: 'Main', venueName: '***' },
      { id: 'e', name: 'Field 1', venueName: 'The' },
      { id: 'f', name: 'Field 2', venueName: 'Team' }
    ]
    expect([...fieldLabels(fields).values()]).deep.equals([
      'Morley Field Sports Complex/Field 1',
      'Morley Field Softball Complex/Field 1',
      'MFS/TB1',
      '***/Main',
      // Only "The" would read as the shortener's placeholder.
      'The/Field 1',
      'TEAM/Field 2'
    ])
  })

  it('offers a season’s teams and the fields its games use, or every one', () => {
    const games = [
      game('2027-03-08T18:00:00.000Z'),
      game('2027-06-08T18:00:00.000Z', {
        seasonId: 'sea_summer',
        fieldId: 'fld_one',
        homeTeamId: 'tem_bears'
      })
    ]
    const all = filterChoices(PREVIEW, games, null)
    expect(all.teams.map(team => team.label)).deep.equals([
      'Demo Bears',
      'Demo Foxes',
      'Demo Hawks',
      'Demo Otters',
      'Demo Owls'
    ])
    expect(all.fields.map(field => field.label)).deep.equals([
      'BALBOA/Field 1',
      'MFS/TB1'
    ])
    const spring = filterChoices(PREVIEW, games, 'sea_spring')
    expect(spring.teams.map(team => team.id)).deep.equals([
      'tem_foxes',
      'tem_hawks',
      'tem_otters',
      'tem_owls'
    ])
    expect(spring.fields.map(field => field.id)).deep.equals(['fld_tb1'])
    // A team the preview does not name still has a pill.
    const unnamed = filterChoices(
      { ...PREVIEW, teams: [] },
      games,
      'sea_summer'
    )
    expect(unnamed.teams.map(team => team.label)).deep.equals([
      'A team',
      'A team'
    ])
  })

  it('puts a team or field the rows no longer offer back to all of them', () => {
    const games = [
      game('2027-03-08T18:00:00.000Z'),
      game('2027-06-08T18:00:00.000Z', {
        seasonId: 'sea_summer',
        fieldId: 'fld_one',
        homeTeamId: 'tem_bears'
      })
    ]
    expect(
      normalizeFilter(
        { seasonId: 'sea_summer', teamId: 'tem_owls', fieldId: 'fld_tb1' },
        PREVIEW,
        games
      ).filter
    ).deep.equals({ seasonId: 'sea_summer', teamId: null, fieldId: null })
    expect(
      normalizeFilter(
        { seasonId: 'sea_summer', teamId: 'tem_hawks', fieldId: 'fld_one' },
        PREVIEW,
        games
      ).filter
    ).deep.equals({
      seasonId: 'sea_summer',
      teamId: 'tem_hawks',
      fieldId: 'fld_one'
    })
    // A field whose last game was rejected leaves the row.
    expect(
      normalizeFilter(
        { seasonId: 'sea_summer', teamId: null, fieldId: 'fld_one' },
        PREVIEW,
        games.slice(0, 1)
      ).filter.fieldId
    ).equals(null)
    // A season the preview no longer has.
    const gone = normalizeFilter(
      { seasonId: 'sea_gone', teamId: 'tem_hawks', fieldId: null },
      PREVIEW,
      games
    )
    expect(gone.filter).deep.equals({
      seasonId: null,
      teamId: 'tem_hawks',
      fieldId: null
    })
    // With the rows it is drawn in.
    expect(gone.choices).deep.equals(filterChoices(PREVIEW, games, null))
    expect(sameFilter(gone.filter, { ...gone.filter })).equals(true)
    expect(sameFilter(gone.filter, ALL_GAMES)).equals(false)
  })

  it('keeps the games in the season, with the team, on the field', () => {
    const a = game('2027-03-08T18:00:00.000Z')
    const b = game('2027-03-09T18:00:00.000Z', {
      homeTeamId: 'tem_foxes',
      awayTeamId: 'tem_hawks',
      fieldId: 'fld_one'
    })
    const c = game('2027-06-08T18:00:00.000Z', {
      seasonId: 'sea_summer',
      homeTeamId: 'tem_bears',
      awayTeamId: 'tem_owls'
    })
    const games = [a, b, c]
    expect(filteredGames(games, ALL_GAMES)).deep.equals(games)
    expect(
      filteredGames(games, { ...ALL_GAMES, seasonId: 'sea_spring' })
    ).deep.equals([a, b])
    // Home or away.
    expect(
      filteredGames(games, { ...ALL_GAMES, teamId: 'tem_hawks' })
    ).deep.equals([a, b])
    expect(
      filteredGames(games, { ...ALL_GAMES, fieldId: 'fld_tb1' })
    ).deep.equals([a, c])
    expect(
      filteredGames(games, {
        seasonId: 'sea_spring',
        teamId: 'tem_owls',
        fieldId: 'fld_tb1'
      })
    ).deep.equals([a])
  })

  it('starts from the chosen season’s first day, or the earliest one', () => {
    expect(firstDayOf(PREVIEW, null)).equals('2027-03-07')
    expect(firstDayOf(PREVIEW, 'sea_summer')).equals('2027-06-01')
    expect(firstDayOf({ seasons: [] }, null)).equals(undefined)
    // A season that does not say is passed over.
    const undated = { ...PREVIEW.seasons[0], startsOn: undefined }
    expect(firstDayOf({ seasons: [undated, PREVIEW.seasons[1]] }, null)).equals(
      '2027-06-01'
    )
    expect(firstDayOf({ seasons: [undated] }, null)).equals(undefined)
  })

  it('counts the weeks from the season, whichever team or field is chosen', () => {
    const undated = {
      seasons: PREVIEW.seasons.map(season => ({
        ...season,
        startsOn: undefined
      }))
    }
    const games = [
      game('2027-03-09T18:00:00.000Z'),
      game('2027-03-16T18:00:00.000Z', {
        homeTeamId: 'tem_foxes',
        awayTeamId: 'tem_otters'
      }),
      game('2027-06-08T18:00:00.000Z', { seasonId: 'sea_summer' })
    ]
    // A season that says: its first day.
    expect(weekAnchor(PREVIEW, games, 'sea_spring', 'UTC')).equals('2027-03-07')
    // None says: the first of the season's games, not the chosen team's.
    expect(weekAnchor(undated, games, 'sea_spring', 'UTC')).equals('2027-03-09')
    expect(weekAnchor(undated, games, 'sea_summer', 'UTC')).equals('2027-06-08')
    expect(weekAnchor(undated, games, null, 'UTC')).equals('2027-03-09')
    expect(weekAnchor(undated, [], null, 'UTC')).equals(undefined)
    // A dated season's game read before its first Monday, by a viewer
    // west of the field, moves the anchor back for every team alike.
    const early = [
      game('2027-03-01T05:30:00.000Z'),
      game('2027-03-09T18:00:00.000Z', {
        homeTeamId: 'tem_foxes',
        awayTeamId: 'tem_otters'
      })
    ]
    const west = 'America/Los_Angeles'
    const dated = weekAnchor(PREVIEW, early, 'sea_spring', west)
    expect(dated).equals('2027-02-28')
    const numbers = (teamId: string | null): number[] =>
      calendarWeeks(filteredGames(early, { ...ALL_GAMES, teamId }), {
        firstDay: dated,
        zone: west
      }).map(week => week.number)
    expect(numbers(null)).deep.equals([1, 3])
    expect(numbers('tem_foxes')).deep.equals([3])
    const anchor = weekAnchor(undated, games, 'sea_spring', 'UTC')
    const foxes = calendarWeeks(
      filteredGames(games, { ...ALL_GAMES, teamId: 'tem_foxes' }),
      { firstDay: anchor, ...UTC }
    )
    expect(foxes.map(week => week.number)).deep.equals([2])
  })

  it('finds the Monday on or before a day', () => {
    expect(mondayOnOrBefore('2027-03-01')).equals('2027-03-01')
    expect(mondayOnOrBefore('2027-03-07')).equals('2027-03-01')
    expect(mondayOnOrBefore('2027-03-06')).equals('2027-03-01')
    expect(mondayOnOrBefore('2023-12-31')).equals('2023-12-25')
  })

  it('numbers weeks from the Monday on or before the first day', () => {
    // A season starting on a Sunday: that Sunday is the last day of Week 1.
    const sunday = calendarWeeks([game('2027-03-07T18:00:00.000Z')], {
      firstDay: '2027-03-07',
      ...UTC
    })
    expect(
      sunday.map(week => [week.number, week.days[0], week.days[6]])
    ).deep.equals([[1, '2027-03-01', '2027-03-07']])
    expect(sunday[0].rows[0][6]?.startAt).equals('2027-03-07T18:00:00.000Z')
    // A season starting on a Monday starts Week 1 there.
    const monday = calendarWeeks([game('2027-03-09T18:00:00.000Z')], {
      firstDay: '2027-03-08',
      ...UTC
    })
    expect(monday[0].days[0]).equals('2027-03-08')
    // A game before Week 1's Monday moves Week 1 back to its own Monday.
    const early = calendarWeeks(
      [game('2027-02-24T18:00:00.000Z'), game('2027-03-09T18:00:00.000Z')],
      { firstDay: '2027-03-08', ...UTC }
    )
    expect(early.map(week => [week.number, week.days[0]])).deep.equals([
      [1, '2027-02-22'],
      [3, '2027-03-08']
    ])
    // With no first day the first game's Monday starts Week 1.
    expect(
      calendarWeeks([game('2027-03-10T18:00:00.000Z')], {
        firstDay: undefined,
        ...UTC
      })[0].days[0]
    ).equals('2027-03-08')
  })

  it('gives a week as many rows as its busiest day has games', () => {
    const late = game('2027-03-10T20:00:00.000Z', {
      homeTeamId: 'tem_foxes',
      awayTeamId: 'tem_otters'
    })
    const early = game('2027-03-10T15:00:00.000Z')
    const tuesday = game('2027-03-09T18:00:00.000Z')
    const friday = game('2027-03-12T18:00:00.000Z', {
      homeTeamId: 'tem_foxes',
      awayTeamId: 'tem_otters'
    })
    const [week] = calendarWeeks([late, tuesday, friday, early], {
      firstDay: '2027-03-08',
      ...UTC
    })
    expect(week.rows.length).equals(2)
    // Wednesday's two games in start order, one per row.
    expect(week.rows[0][2]).equals(early)
    expect(week.rows[1][2]).equals(late)
    // Two teams on different days share the first row.
    expect(week.rows[0][1]).equals(tuesday)
    expect(week.rows[0][4]).equals(friday)
    expect(week.rows[1][1]).equals(undefined)
    expect(week.rows[1][4]).equals(undefined)
    expect(week.rows[0][0]).equals(undefined)
    // Two games at the same start keep their keys' order.
    const same = [
      game('2027-03-09T18:00:00.000Z'),
      game('2027-03-09T18:00:00.000Z')
    ]
    const [tied] = calendarWeeks([same[1], same[0]], {
      firstDay: '2027-03-08',
      ...UTC
    })
    expect(tied.rows.map(row => row[1])).deep.equals(same)
  })

  it('leaves out the weeks with no game, and the rest keep their numbers', () => {
    const weeks = calendarWeeks(
      [game('2027-03-09T18:00:00.000Z'), game('2027-03-30T18:00:00.000Z')],
      { firstDay: '2027-03-08', ...UTC }
    )
    expect(weeks.map(week => week.number)).deep.equals([1, 4])
    expect(weekTitle(weeks[1])).equals('Week 4 · Mar 29 – Apr 4')
    expect(calendarWeeks([], { firstDay: '2027-03-08', ...UTC })).deep.equals(
      []
    )
  })

  it('reads each game’s day in the viewer’s zone', () => {
    const zone = 'America/Los_Angeles'
    // 11:30 PM Saturday in New York is 8:30 PM Saturday in Los Angeles.
    const newYork = game('2027-03-14T03:30:00.000Z')
    // 1:30 AM Sunday UTC is 6:30 PM Saturday in Los Angeles.
    const utc = game('2027-03-14T01:30:00.000Z')
    const [week] = calendarWeeks([newYork, utc], {
      firstDay: '2027-03-08',
      zone
    })
    expect(week.rows.map(row => row[5])).deep.equals([utc, newYork])
    expect(week.rows[0][6]).equals(undefined)
  })

  it('heads each column with its weekday, month and two-digit day', () => {
    expect(dayHeader('2027-03-02')).equals('Tue · Mar · 02')
    expect(dayHeader('2027-12-26')).equals('Sun · Dec · 26')
    expect(dayHeader('2027-01-11')).equals('Mon · Jan · 11')
  })
})
