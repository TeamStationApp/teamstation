import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asGameDetail,
  asRosterEntry,
  type Lineup,
  type LineupPerson,
  type RosterEntry
} from '../../common/api'
import {
  type GameSetup,
  type Position,
  POSITIONS,
  type Side
} from '../../common/scoring/state'
import { startingSetup } from './developmentSession'

const game = asGameDetail({
  nonMemberView: false,
  id: 'g1',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  canScore: true,
  videos: []
})

function roster(userIds: number[]): RosterEntry[] {
  return userIds.map(userId =>
    asRosterEntry({
      userId,
      shortName: `Player ${userId}`,
      jersey: String(userId % 100),
      positions: [],
      isPlayer: true,
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
    })
  )
}
const person = (userId: number | null, name?: string): LineupPerson => ({
  userId,
  name: name ?? `Player ${userId}`,
  jersey: userId == null ? '0' : String(userId % 100)
})
const noDefense = (): Record<Position, LineupPerson | null> =>
  Object.fromEntries(POSITIONS.map(position => [position, null])) as Record<
    Position,
    LineupPerson | null
  >

/** The order by user id or name, and the fielders by position. */
function arranged(
  setup: GameSetup,
  side: Side
): { order: Array<number | string>; defense: Record<string, number | string> } {
  const who = (id: number): number | string =>
    setup.players[id].userId ?? setup.players[id].fullName
  const team = setup.sides[side]
  const defense: Record<string, number | string> = {}
  for (const position of POSITIONS) {
    const id = team.defense[position]
    if (id != null) defense[position] = who(id)
  }
  return { order: team.battingOrder.map(who), defense }
}

describe('the lineups a game starts from (U12)', function () {
  const away = roster([101, 102, 103, 104, 105, 106, 107, 108, 109, 110])
  const home = roster([201, 202, 203, 204, 205, 206, 207, 208, 209])

  it('keeps roster order without a default', function () {
    const setup = startingSetup(game, away, home)
    expect(arranged(setup, 'away').order).deep.equals([
      101, 102, 103, 104, 105, 106, 107, 108, 109, 110
    ])
    expect(startingSetup(game, away, home, { away: null })).deep.equals(setup)
  })

  it('fills the order and the defence from the default', function () {
    const lineup: Lineup = {
      batters: [109, 108, 107, 106, 105, 104, 103, 102, 101].map(id =>
        person(id)
      ),
      defense: {
        ...noDefense(),
        P: person(105),
        C: person(104),
        SS: person(101)
      }
    }
    const setup = startingSetup(game, away, home, { away: lineup })
    expect(arranged(setup, 'away')).deep.equals({
      order: [109, 108, 107, 106, 105, 104, 103, 102, 101],
      defense: { P: 105, C: 104, SS: 101 }
    })
    // The roster player the default leaves out sits on the bench.
    const bench = setup.sides.away.players.map(id => setup.players[id].userId)
    expect(bench).includes(110)
    // The other side is built from its roster.
    expect(arranged(setup, 'home').order).deep.equals([
      201, 202, 203, 204, 205, 206, 207, 208, 209
    ])
  })

  it('drops whoever has left, benches newcomers and makes placeholders again', function () {
    const lineup: Lineup = {
      batters: [
        person(101),
        person(null, 'Guest'),
        person(999),
        person(102),
        person(null, 'Guest')
      ],
      defense: {
        ...noDefense(),
        P: person(null, 'Guest'),
        C: person(999),
        '1B': person(101),
        SS: person(101)
      }
    }
    // 999 has left; 103 is new; the roster is short, so it would top up.
    const setup = startingSetup(game, roster([101, 102, 103]), home, {
      away: lineup
    })
    expect(arranged(setup, 'away')).deep.equals({
      order: [101, 'Guest', 102],
      defense: { P: 'Guest', '1B': 101 }
    })
    const team = setup.sides.away
    const guest = team.battingOrder[1]
    expect(setup.players[guest]).deep.include({
      userId: null,
      fullName: 'Guest',
      jersey: '0',
      local: true,
      teamId: 'away'
    })
    // No made-up "Player N" is left over from the roster's top-up.
    expect(
      team.players.map(
        id => setup.players[id].userId ?? setup.players[id].fullName
      )
    ).deep.equals([101, 102, 103, 'Guest'])
    expect(
      Object.values(setup.players).filter(p => p.teamId === 'away')
    ).length(4)
    expect(setup.sides.away.battingIndex).equals(0)
  })

  it('keeps incomplete defaults visible for lineup and defensive setup', function () {
    const gone: Lineup = {
      batters: [person(998), person(999)],
      defense: { ...noDefense(), P: person(101) }
    }
    const empty = startingSetup(game, away, home, { away: gone })
    expect(empty.sides.away.battingOrder).deep.equals([])
    expect(empty.sides.away.defense.P).not.equals(null)
    const noPitcher: Lineup = {
      batters: [person(101)],
      defense: { ...noDefense(), P: person(999) }
    }
    const incomplete = startingSetup(game, away, home, { away: noPitcher })
    expect(incomplete.sides.away.battingOrder).has.length(1)
    expect(incomplete.sides.away.defense.P).equals(null)
  })
})
