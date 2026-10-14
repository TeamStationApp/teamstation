import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asGameDetail,
  asRosterEntry,
  type Lineup,
  type LineupPerson,
  type RosterEntry
} from '../api'
import type { ScoringAction } from './actions'
import { freshGame } from './lineup'
import {
  defaultPending,
  defaultsUnaccepted,
  shownWithDefault,
  startingSetup,
  teamsOf,
  withVisibleDefaults
} from './startingSetup'
import {
  type GameSetup,
  type Position,
  POSITIONS,
  setupOf,
  type Side
} from './state'

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

describe('the lineups a game starts from (U4b)', function () {
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

  it('tops a short roster up to nine, or leaves it as it is', function () {
    const short = roster([101, 102, 103])
    const filled = startingSetup(game, short, home)
    expect(arranged(filled, 'away').order).deep.equals([
      101,
      102,
      103,
      'Player 4',
      'Player 5',
      'Player 6',
      'Player 7',
      'Player 8',
      'Player 9'
    ])
    const kept = startingSetup(game, short, home, {}, false)
    expect(arranged(kept, 'away').order).deep.equals([101, 102, 103])
    expect(arranged(kept, 'away').defense).deep.equals({
      P: 101,
      C: 102,
      '1B': 103
    })
  })

  it('starts an empty roster with nobody, or with nine made up', function () {
    const empty = startingSetup(game, [], home, {}, false)
    expect(empty.sides.away).deep.include({
      players: [],
      battingOrder: [],
      battingIndex: 0
    })
    expect(
      Object.values(empty.sides.away.defense).every(id => id == null)
    ).equals(true)
    const made = startingSetup(game, [], [])
    expect(made.sides.away.battingOrder).length(9)
    expect(made.sides.home.battingOrder).length(9)
    expect(
      made.sides.home.battingOrder.every(id => made.players[id].local)
    ).equals(true)
    // Staff and anyone else who does not play is left off.
    const staff = asRosterEntry({
      userId: 300,
      shortName: 'Coach',
      jersey: '',
      positions: [],
      isPlayer: false,
      role: 'coach',
      section: 'staff',
      staffRoles: [],
      inheritedFrom: null
    })
    expect(
      startingSetup(game, [staff], home, {}, false).sides.away.players
    ).deep.equals([])
  })

  it("names each side's team from the game", function () {
    expect(teamsOf(game)).deep.equals({
      away: { id: 'away', name: 'Owls', logoUrl: game.awayLogoUrl },
      home: { id: 'home', name: 'Hawks', logoUrl: game.homeLogoUrl }
    })
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

describe('a reader who can see a side left unseen', function () {
  const away = roster([101, 102, 103, 104, 105, 106, 107, 108, 109])
  const home = roster([201, 202, 203, 204, 205, 206, 207, 208, 209])
  const stored = startingSetup(game, away, home)
  const state = freshGame('g1', teamsOf(game), stored)
  const reversed: Lineup = {
    batters: [109, 108, 107, 106, 105, 104, 103, 102, 101].map(id =>
      person(id)
    ),
    defense: noDefense()
  }
  const blind: ScoringAction = {
    type: 'lineup',
    kind: 'roster',
    setup: stored,
    unseen: ['away'],
    confirmed: ['home']
  }

  it('shows the default while the stored order is still that roster order', function () {
    const shown = shownWithDefault(state, [blind], 'away', reversed)
    expect(arranged(setupOf(shown), 'away').order).deep.equals([
      109, 108, 107, 106, 105, 104, 103, 102, 101
    ])
    expect(arranged(setupOf(state), 'away').order[0]).equals(101)
    expect(shownWithDefault(state, [blind], 'home', reversed)).equals(state)
    expect(shownWithDefault(state, [blind], 'away', null)).equals(state)
    expect(defaultPending(state, [blind], 'away', reversed)).equals(true)
    expect(defaultPending(state, [blind], 'home', reversed)).equals(false)
    expect(defaultPending(state, [blind], 'away', null)).equals(false)
    const both = withVisibleDefaults(state, [blind], {
      away: reversed,
      home: reversed
    })
    expect(arranged(setupOf(both), 'away').order[0]).equals(109)
    expect(arranged(setupOf(both), 'home').order[0]).equals(201)
    expect(defaultsUnaccepted([blind], { away: reversed })).equals(true)
    expect(defaultsUnaccepted([blind], { home: reversed })).equals(false)
    expect(defaultsUnaccepted([blind], {})).equals(false)
  })

  it('shows the stored lineup once it is no longer that order', function () {
    const changed = setupOf(state)
    const order = changed.sides.away.battingOrder
    changed.sides.away.battingOrder = [order[1], order[0], ...order.slice(2)]
    const next = freshGame('g1', teamsOf(game), changed)
    const shown = shownWithDefault(
      next,
      [blind, { type: 'lineup', kind: 'roster', setup: changed }],
      'away',
      reversed
    )
    expect(shown).equals(next)
    expect(arranged(setupOf(shown), 'away').order[0]).equals(102)
  })
})
