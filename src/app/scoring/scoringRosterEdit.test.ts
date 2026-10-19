import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry } from '../../common/api'
import { ROLES } from '../../common/roles'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  editRosterLabel,
  editRosterRows,
  rosterHand,
  rosterStaffSide
} from './scoringRosterEdit'

const entry = (
  id: number,
  jersey: string | null,
  firstName = 'Mookie',
  lastName = 'Betts'
): ReturnType<typeof asRosterEntry> =>
  asRosterEntry({
    userId: id,
    shortName: `${firstName} ${lastName[0]}`,
    nameDetails: {
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`
    },
    jersey,
    bats: 'switch',
    throws: 'left',
    positions: [],
    isPlayer: true,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null
  })
describe('roster editing presentation', function () {
  it('prefers only one team with any staff or admin role, including scorekeeper', function () {
    for (const role of ROLES) {
      expect(
        rosterStaffSide({ teams: { away: [role] } }, 'away', 'home')
      ).equals('away')
      expect(
        rosterStaffSide({ teams: { home: [role] } }, 'away', 'home')
      ).equals('home')
      expect(
        rosterStaffSide(
          { teams: { away: [role], home: ['admin'] } },
          'away',
          'home'
        )
      ).equals(undefined)
    }
    expect(rosterStaffSide({ teams: {} }, 'away', 'home')).equals(undefined)
    expect(
      rosterStaffSide({ teams: { other: ['admin'] } }, 'away', 'home')
    ).equals(undefined)
    expect(rosterStaffSide(undefined, 'away', 'home')).equals(undefined)
  })
  it('orders either partially split legacy name by its authorized full label', function () {
    const state = scoringSession(gameFixture)
    state.liveData.boxscore.teams.away.players = []
    const rows = editRosterRows(
      [
        {
          ...entry(1, null, 'Aaron', 'Judge'),
          nameDetails: {
            firstName: null,
            lastName: 'Judge',
            displayName: 'Aaron Judge'
          }
        },
        entry(2, null, 'Bryce', 'Harper'),
        {
          ...entry(3, null, 'Adam', 'Frazier'),
          nameDetails: {
            firstName: 'Adam',
            lastName: null,
            displayName: 'Adam Frazier'
          }
        },
        entry(4, null, 'Adam', 'Duvall')
      ],
      state,
      'away'
    )
    expect(rows.map(row => row.name)).deep.equals([
      'Aaron Judge',
      'Adam Duvall',
      'Adam Frazier',
      'Bryce Harper'
    ])
  })
  it('shows one roster card when a guest has joined the team', function () {
    const state = scoringSession(gameFixture)
    const id = state.liveData.boxscore.teams.away.players[0]
    state.liveData.boxscore.teams.away.players = [id]
    state.gameData.players[id].positions = ['C', 'DH']
    const rows = editRosterRows(
      [{ ...entry(id, '1'), positions: ['P', 'SS', 'CF'] }],
      state,
      'away'
    )
    expect(rows).has.length(1)
    expect(new Set(rows.map(row => row.key)).size).equals(1)
    expect(rows.filter(row => row.userId == null)).has.length(0)
    expect(rows.find(row => row.userId != null)!.positions).deep.equals([
      'P',
      'SS',
      'CF'
    ])
  })
  it('sorts numeric, legacy and missing jerseys without changing roster or game names', function () {
    const state = scoringSession(gameFixture)
    state.liveData.boxscore.teams.away.players = []
    const rows = [
      entry(1, '12'),
      entry(2, '2'),
      entry(3, '1'),
      entry(4, '99'),
      entry(5, '100'),
      entry(6, '00'),
      entry(7, '0'),
      entry(8, 'A2'),
      entry(9, 'A10'),
      entry(10, null, 'zack', 'Wheeler'),
      entry(11, ' ', 'Adam', 'Duvall'),
      entry(12, '', 'Adam', 'Duvall')
    ]
    const before = JSON.stringify({ rows, state })
    expect(editRosterRows(rows, state, 'away').map(row => row.id)).deep.equals([
      7, 6, 3, 2, 1, 4, 5, 8, 9, 11, 12, 10
    ])
    expect(JSON.stringify({ rows, state })).equals(before)
  })
  it('includes bench players, skips nonplayers, and uses short-name/legacy fallbacks', function () {
    const state = scoringSession(gameFixture)
    state.liveData.boxscore.teams.away.players = []
    const short = { ...entry(1, null), nameDetails: undefined }
    const legacy = {
      ...entry(2, null),
      nameDetails: {
        firstName: null,
        lastName: null,
        displayName: 'Aaron Judge'
      }
    }
    const rows = editRosterRows(
      [short, legacy, { ...entry(3, '1'), isPlayer: false }],
      state,
      'away'
    )
    expect(rows.map(row => row.name)).deep.equals(['Aaron Judge', 'Mookie B'])
    expect(rows.every(row => row.userId != null)).equals(true)
    expect(editRosterLabel(rows[0])).includes(
      'bats switch, throws left, edit settings'
    )
  })
  it('presents hands without manufacturing unknown values', function () {
    expect(
      ['left', 'right', 'switch', null].map(value =>
        rosterHand(value as Parameters<typeof rosterHand>[0])
      )
    ).deep.equals(['L', 'R', 'S', '—'])
  })
})
