import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  buildable,
  type CheckedField,
  type CheckedSeason,
  schedulingChecks
} from './schedulingChecks'

const FIELD: CheckedField = {
  id: 'fld_one',
  name: 'Field 1',
  venueName: 'Demo Park',
  sizes: ['50/70'],
  startsOn: null,
  endsOn: null,
  deleted: false
}

function season(
  changes: Partial<CheckedSeason['settings']> = {},
  more: Partial<CheckedSeason> = {}
): CheckedSeason {
  return {
    id: 'sea_one',
    name: 'Demo Regular',
    participants: 8,
    exhibitionTeams: 2,
    ...more,
    settings: {
      fieldSize: '50/70',
      gameMinutes: 90,
      regularGames: 4,
      exhibitionGames: 1,
      startsOn: '2027-03-01',
      endsOn: '2027-07-31',
      windows: [
        {
          from: '2027-03-01',
          hours: [{ weekday: 6, start: '08:00', end: '18:00' }]
        }
      ],
      ...changes
    }
  }
}

const kinds = (seasons: CheckedSeason[], fields = [FIELD]): string[] =>
  schedulingChecks(seasons, fields).map(check => check.kind)

describe('schedulingChecks', () => {
  it('is silent when everything divides evenly and has room', () => {
    expect(schedulingChecks([season()], [FIELD])).deep.equals([])
    expect(buildable([])).equals(true)
  })

  it('names an odd regular-season total', () => {
    const [odd] = schedulingChecks(
      [season({ regularGames: 3 }, { participants: 7 })],
      [FIELD]
    ).filter(check => check.kind === 'oddTotal')
    expect(odd).deep.equals({
      kind: 'oddTotal',
      seasonId: 'sea_one',
      message:
        'Demo Regular: 7 teams × 3 games is 21 team games, an odd number, so one team plays one regular-season game fewer.',
      blocking: false
    })
    expect(
      kinds([season({ regularGames: 4 }, { participants: 7 })])
    ).not.includes('oddTotal')
  })

  it('names the split of exhibition games that don’t divide evenly', () => {
    const message = (participants: number, teams: number): string[] =>
      schedulingChecks(
        [season({}, { participants, exhibitionTeams: teams })],
        [FIELD]
      )
        .filter(check => check.kind === 'unevenExhibition')
        .map(check => check.message)
    expect(message(7, 2)).deep.equals([
      'Demo Regular: 7 exhibition games don’t split evenly over 2 exhibition teams: 4 for one, 3 for the other.'
    ])
    expect(message(8, 3)).deep.equals([
      'Demo Regular: 8 exhibition games don’t split evenly over 3 exhibition teams: 3 for some, 2 for the other.'
    ])
    expect(message(7, 3)).deep.equals([
      'Demo Regular: 7 exhibition games don’t split evenly over 3 exhibition teams: 3 for one, 2 for the others.'
    ])
    expect(message(8, 2)).deep.equals([])
  })

  it('warns of exhibition games with no exhibition teams, without blocking', () => {
    const checks = schedulingChecks(
      [season({}, { exhibitionTeams: 0 })],
      [FIELD]
    )
    expect(checks.map(check => check.kind)).deep.equals(['noExhibitionTeams'])
    expect(buildable(checks)).equals(true)
    expect(
      kinds([season({ exhibitionGames: 0 }, { exhibitionTeams: 0 })])
    ).deep.equals([])
  })

  it('blocks a run with no season, no games, no field of the size or no windows', () => {
    expect(kinds([])).deep.equals(['noSeasons'])
    expect(
      kinds([season({ regularGames: 0, exhibitionGames: 0 })])
    ).deep.equals(['noGames'])
    const noField = schedulingChecks([season({ fieldSize: '60/90' })], [FIELD])
    expect(noField.map(check => check.message)).deep.equals([
      'Demo Regular has no chosen field that sets up as 60/90.'
    ])
    expect(buildable(noField)).equals(false)
    expect(kinds([season()], [{ ...FIELD, deleted: true }])).deep.equals([
      'noField'
    ])
    expect(kinds([season({ windows: [] })])).deep.equals(['noWindows'])
    expect(
      kinds([season({ windows: [{ from: '2027-03-01', hours: [] }] })])
    ).deep.equals(['noWindows'])
  })

  it('warns of a field whose dates don’t cover the season', () => {
    expect(
      schedulingChecks(
        [season()],
        [{ ...FIELD, startsOn: '2027-04-01', endsOn: '2027-10-31' }]
      ).map(check => check.message)
    ).deep.equals([
      'Field 1 at Demo Park is open Apr 1 to Oct 31, not all of Demo Regular.'
    ])
    expect(
      kinds(
        [season()],
        [{ ...FIELD, startsOn: '2027-01-01', endsOn: '2027-06-30' }]
      )
    ).deep.equals(['fieldDates'])
    expect(
      kinds(
        [season()],
        [{ ...FIELD, startsOn: '2027-01-01', endsOn: '2027-12-31' }]
      )
    ).deep.equals([])
  })

  it('warns of a game window shorter than a game', () => {
    expect(
      schedulingChecks(
        [
          season({
            windows: [
              {
                from: '2027-06-01',
                hours: [
                  { weekday: 2, start: '18:00', end: '19:00' },
                  { weekday: 6, start: '08:00', end: '18:00' }
                ]
              }
            ]
          })
        ],
        [FIELD]
      ).map(check => check.message)
    ).deep.equals([
      'Demo Regular: the Tuesday window 18:00–19:00 from Jun 1 is shorter than a 90-minute game.'
    ])
  })

  it('says a single team and game plainly', () => {
    expect(
      schedulingChecks(
        [season({ regularGames: 1, exhibitionGames: 0 }, { participants: 1 })],
        [FIELD]
      ).map(check => check.message)
    ).deep.equals([
      'Demo Regular: 1 team × 1 game is 1 team game, an odd number, so one team plays one regular-season game fewer.'
    ])
  })
})
