import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import { addPlayer, freshGame, newSetup } from './lineup'
import {
  asLineup,
  confirmedSides,
  type Lineup,
  type LineupChange,
  lineupHistory,
  lineupOf,
  type LineupPerson,
  placeholderSidesOf,
  readLineups,
  reconcileShownLineup,
  sameArrangement,
  unseenLineup
} from './lineupHistory'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from './session'
import { type GameSetup, lineupsOf, type Position, POSITIONS } from './state'

/**
 * Two teams of real players: the visitors are users 101-110, session ids
 * 1-10, with 110 on the bench; the hosts are users 201-209, session ids
 * 11-19, fielding P 11, C 12, 1B 13, 2B 14, SS 15, 3B 16, LF 17, CF 18,
 * RF 19.
 */
const TEAMS = {
  away: { id: 'team-away', name: 'Visitors' },
  home: { id: 'team-home', name: 'Hosts' }
}
const roster = (
  first: number,
  count: number
): Array<{ userId: number; shortName: string; jersey: string }> =>
  Array.from({ length: count }, (_, i) => ({
    userId: first + i,
    shortName: `Player ${first + i}`,
    jersey: String(i + 1)
  }))
function setup(): GameSetup {
  const made = newSetup(TEAMS, {
    away: roster(101, 10),
    home: roster(201, 9)
  })
  made.sides.away.battingOrder = made.sides.away.battingOrder.slice(0, 9)
  return made
}
const context = { gamePk: 'g1', teams: TEAMS, setup: setup() }

/** A server in memory, as the session sees one. */
function store(): EventStore & { game: StoredGame } {
  const kept: { game: StoredGame } = { game: { plays: [], currentPlay: null } }
  return {
    get game() {
      return kept.game
    },
    load: async () => kept.game,
    save: async (_gameId: string, change: SaveChange) => {
      const plays = new Map(
        kept.game.plays.map(play => [play.about.atBatIndex, play])
      )
      for (const index of change.remove) plays.delete(index)
      for (const play of change.plays)
        plays.set(
          play.about.atBatIndex,
          JSON.parse(JSON.stringify(play)) as GumboPlay
        )
      kept.game = {
        plays: [...plays.values()].sort(
          (a, b) => a.about.atBatIndex - b.about.atBatIndex
        ),
        currentPlay:
          change.currentPlay === undefined
            ? kept.game.currentPlay
            : (JSON.parse(
                JSON.stringify(change.currentPlay)
              ) as CurrentPlay | null)
      }
      return kept.game
    }
  }
}

const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }
const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const K = [strike, strike, strike, close]
const single: ScoringAction[] = [
  { type: 'ballInPlay', contact: 'swing', fielder: 208 },
  { type: 'result', eventType: 'single' }
]

async function scored(
  actions: ScoringAction[]
): Promise<{ session: ScoringSession; kept: ReturnType<typeof store> }> {
  const kept = store()
  const session = await ScoringSession.open(kept, 'g1', context)
  for (const action of actions)
    expect(session.apply(action).problems, JSON.stringify(action)).deep.equals(
      []
    )
  await session.flush()
  return { session, kept }
}

const users = (lineup: Lineup | null): Array<number | string | null> =>
  lineup?.batters.map(person => person.userId ?? person.name) ?? []
const summary = (change: LineupChange): string =>
  [
    change.atBatIndex,
    change.side,
    change.eventType,
    change.position,
    change.battingOrder,
    change.player.userId ?? change.player.name,
    change.replaced?.userId ?? change.replaced?.name ?? '-'
  ].join(' ')

describe('lineup history (U9)', function () {
  it('reads the arranged lineup as the start only once the game has begun, announcing nothing', async function () {
    const { session, kept } = await scored([
      {
        type: 'lineup',
        kind: 'battingOrder',
        side: 'away',
        order: [102, 101, 103, 104, 105, 106, 107, 108, 109]
      },
      {
        type: 'lineup',
        kind: 'position',
        side: 'home',
        player: 205,
        position: 'P'
      }
    ])
    let read = readLineups(kept.game, context)
    expect(read.begun).equals(false)
    expect(read.sides.away.start).equals(null)
    expect(read.sides.home.start).equals(null)
    expect(read.sides.away.changes).deep.equals([])
    expect(users(read.sides.away.current)).deep.equals([
      102, 101, 103, 104, 105, 106, 107, 108, 109
    ])
    expect(read.sides.home.current?.defense.P?.userId).equals(205)
    expect(read.sides.home.current?.defense.SS).equals(null)

    session.apply(ball)
    await session.flush()
    read = readLineups(kept.game, context)
    expect(read.begun).equals(true)
    expect(users(read.sides.away.start)).deep.equals([
      102, 101, 103, 104, 105, 106, 107, 108, 109
    ])
    expect(read.sides.home.start?.defense.P).deep.equals({
      userId: 205,
      name: 'Player 205',
      jersey: '5'
    })
    expect([
      ...read.sides.away.changes,
      ...read.sides.home.changes
    ]).deep.equals([])
    expect(
      sameArrangement(read.sides.away.start!, read.sides.away.current!)
    ).equals(true)
  })

  it('announces a pinch hitter for the batter due at once, in the current play', async function () {
    const { kept } = await scored([
      ...K,
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: 110,
        replaces: 102
      }
    ])
    const sides = lineupHistory(kept.game, context)
    expect(sides.away.changes.map(summary)).deep.equals([
      '1 away offensive_substitution PH 201 110 102'
    ])
    expect(kept.game.currentPlay?.about.atBatIndex).equals(1)
    const [change] = sides.away.changes
    expect(change).deep.include({ inning: 1, half: 'top' })
    expect(change.player).deep.equals({
      userId: 110,
      name: 'Player 110',
      jersey: '10'
    })
    expect(change.description).includes('Pinch-hitter')
    expect(users(sides.away.current)[1]).equals(110)
    // The start is the lineup the game began with.
    expect(users(sides.away.start)[1]).equals(102)
  })

  it('keeps a pinch hitter for a later slot out of the changes until he bats', async function () {
    const bench: ScoringAction = {
      type: 'lineup',
      kind: 'addPlayer',
      player: 9000000,
      side: 'away',
      name: 'Away Bench',
      jersey: '44'
    }
    const early = await scored([
      bench,
      ball,
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: 9000000,
        replaces: 103
      }
    ])
    let sides = lineupHistory(early.kept.game, context)
    expect(users(sides.away.current)[2]).equals(9000000)
    expect(sides.away.current?.batters[2].jersey).equals('44')
    expect(sides.away.changes).deep.equals([])
    // The next batter up is not him: still nothing announced.
    for (const action of K)
      expect(early.session.apply(action).problems).deep.equals([])
    await early.session.flush()
    expect(lineupHistory(early.kept.game, context).away.changes).deep.equals([])
    // Then he is up: announced in the play he bats in.
    for (const action of K)
      expect(early.session.apply(action).problems).deep.equals([])
    await early.session.flush()
    sides = lineupHistory(early.kept.game, context)
    expect(sides.away.changes.map(summary)).deep.equals([
      '2 away offensive_substitution PH 301 9000000 103'
    ])
    expect(sides.away.changes[0].player.jersey).equals('44')
  })

  it('announces a pinch runner where he takes the base', async function () {
    const { kept } = await scored([
      ...single,
      {
        type: 'lineup',
        kind: 'pinchRunner',
        side: 'away',
        base: '1B',
        player: 110
      }
    ])
    const sides = lineupHistory(kept.game, context)
    expect(sides.away.changes.map(summary)).deep.equals([
      '1 away offensive_substitution PR 101 110 101'
    ])
    expect(users(sides.away.current)[0]).equals(110)
  })

  it('lists no change for a pinch runner who keeps the batting order (U4)', async function () {
    const { kept } = await scored([
      ...single,
      {
        type: 'lineup',
        kind: 'runner',
        side: 'away',
        base: '1B',
        player: 110
      },
      ...K
    ])
    const stored = kept.game.plays.flatMap(play => play.playEvents ?? [])
    expect(
      stored.some(
        event =>
          (event as { details?: { eventType?: string } }).details?.eventType ===
          'ts_courtesy_runner'
      )
    ).equals(true)
    const sides = lineupHistory(kept.game, context)
    expect([...sides.away.changes, ...sides.home.changes]).deep.equals([])
    expect(users(sides.away.current)).deep.equals([
      101, 102, 103, 104, 105, 106, 107, 108, 109
    ])
  })

  it("writes a side's fielding changes when it next takes the field, and a reorder at once", async function () {
    const swap: ScoringAction = {
      type: 'lineup',
      kind: 'position',
      side: 'away',
      player: 106,
      position: 'P'
    }
    const { session, kept } = await scored([ball, swap])
    let sides = lineupHistory(kept.game, context)
    // The side at bat moved its fielders: current at once, announced later.
    expect(sides.away.current?.defense.P?.userId).equals(106)
    expect(sides.away.changes).deep.equals([])
    for (const action of [...K, ...K, ...K, ball])
      expect(session.apply(action).problems).deep.equals([])
    // The hosts change pitchers and reorder while in the field.
    for (const action of [
      {
        type: 'lineup',
        kind: 'position',
        side: 'home',
        player: 209,
        position: 'P'
      },
      {
        type: 'lineup',
        kind: 'battingOrder',
        side: 'home',
        order: [202, 201, 203, 204, 205, 206, 207, 208, 209]
      }
    ] satisfies ScoringAction[])
      expect(session.apply(action).problems, action.kind).deep.equals([])
    await session.flush()
    sides = lineupHistory(kept.game, context)
    // The visitors take the field at play 3 and announce their change there;
    // the hosts, now at bat, reorder at once and change pitchers for later.
    expect(sides.away.changes.map(summary)).deep.equals([
      '3 away pitching_substitution P  106 -'
    ])
    expect(sides.home.changes.map(summary)).deep.equals([
      '3 home ts_batting_order   202 -'
    ])
    expect(sides.home.current?.defense.P?.userId).equals(209)
    expect(users(sides.home.current).slice(0, 2)).deep.equals([202, 201])
  })

  it('shows a change undone before it is announced nowhere', async function () {
    const { session, kept } = await scored([
      ...K,
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: 110,
        replaces: 102
      }
    ])
    session.undo()
    await session.flush()
    const sides = lineupHistory(kept.game, context)
    expect(sides.away.changes).deep.equals([])
    expect(users(sides.away.current)).not.includes(110)
  })

  it("reads an imported game's substitutions, with no start or current lineup", function () {
    const imported = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'bottom' },
      result: { eventType: 'single', awayScore: 0, homeScore: 0 },
      playEvents: [
        {
          isSubstitution: true,
          details: {
            eventType: 'pitching_substitution',
            description: 'Pitching Change: Ann replaces Bo.'
          },
          player: { id: 301, fullName: 'Ann' },
          position: 'P'
        },
        {
          isSubstitution: true,
          details: { eventType: 'offensive_substitution' },
          player: { fullName: 'Cy' },
          position: { abbreviation: 'PH' },
          battingOrder: '301',
          replacedPlayer: { id: 302, fullName: 'Di' }
        },
        { isSubstitution: true, details: { eventType: 'something_else' } },
        { isPitch: true, details: { eventType: 'ball' } },
        'nonsense'
      ]
    } as unknown as GumboPlay
    const read = readLineups(
      { plays: [imported], currentPlay: null },
      {
        gamePk: 'g1',
        teams: TEAMS
      }
    )
    expect(read.begun).equals(true)
    expect(read.sides.away.start).equals(null)
    expect(read.sides.away.current).equals(null)
    expect(read.sides.home.current).equals(null)
    expect(read.sides.away.changes.map(summary)).deep.equals([
      '0 away pitching_substitution P  301 -'
    ])
    expect(read.sides.home.changes.map(summary)).deep.equals([
      '0 home offensive_substitution PH 301 Cy 302'
    ])
    expect(read.sides.away.changes[0].description).equals(
      'Pitching Change: Ann replaces Bo.'
    )
    expect(read.sides.home.changes[0].description).equals('')
    // Nothing stored at all has not begun.
    expect(
      readLineups(
        { plays: [], currentPlay: null },
        { gamePk: 'g1', teams: TEAMS }
      ).begun
    ).equals(false)
  })

  it('gives no start and no current lineup for a record that no longer replays', async function () {
    const { kept } = await scored([...K, ball])
    // An action that no longer applies.
    const refused = JSON.parse(JSON.stringify(kept.game)) as StoredGame
    const record = (
      refused.currentPlay as unknown as { teamStation: { actions: unknown[] } }
    ).teamStation
    record.actions = [
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: 99,
        replaces: 101
      }
    ]
    let read = readLineups(refused, context)
    expect(read.problem).not.equals(null)
    expect(read.begun).equals(null)
    expect(read.sides.away.start).equals(null)
    expect(read.sides.away.current).equals(null)
    // A setup the game cannot start from.
    const broken = JSON.parse(JSON.stringify(kept.game)) as StoredGame
    for (const play of [...broken.plays, broken.currentPlay]) {
      const setupBefore = (
        play as unknown as { teamStation: { setupBefore: GameSetup } }
      ).teamStation.setupBefore
      setupBefore.sides.away.battingOrder = []
    }
    read = readLineups(broken, context)
    expect(read.problem).includes('batter')
    expect(read.sides.home.current).equals(null)
  })

  it('compares arrangements by user id, and placeholders by name', function () {
    const person = (userId: number | null, name: string): LineupPerson => ({
      userId,
      name,
      jersey: ''
    })
    const empty = Object.fromEntries(
      POSITIONS.map(position => [position, null])
    ) as Record<Position, LineupPerson | null>
    const a: Lineup = {
      batters: [person(1, 'Ann'), person(null, 'Guest')],
      defense: { ...empty, P: person(1, 'Ann') }
    }
    expect(
      sameArrangement(a, {
        batters: [person(1, 'Ann B'), person(null, 'Guest')],
        defense: { ...empty, P: { ...person(1, 'Ann'), jersey: '9' } }
      })
    ).equals(true)
    expect(
      sameArrangement(a, {
        ...a,
        batters: [person(1, 'Ann'), person(null, 'Other')]
      })
    ).equals(false)
    expect(sameArrangement(a, { ...a, batters: [person(1, 'Ann')] })).equals(
      false
    )
    expect(
      sameArrangement(a, { ...a, defense: { ...empty, C: person(1, 'Ann') } })
    ).equals(false)
    expect(asLineup(JSON.parse(JSON.stringify(a)))).deep.equals(a)
    expect(() => asLineup({ batters: [{ userId: 'x' }] })).throws()
  })

  it('names each person of an engine lineup as the game knows him', function () {
    const made = setup()
    const lineups = {
      away: {
        battingOrder: made.sides.away.battingOrder,
        defense: made.sides.away.defense
      },
      home: {
        battingOrder: made.sides.home.battingOrder,
        defense: made.sides.home.defense
      }
    }
    const lineup = lineupOf(lineups, 'home', made.players)
    expect(lineup.batters[0]).deep.equals({
      userId: 201,
      name: 'Player 201',
      jersey: '1'
    })
    expect(lineup.defense.RF?.userId).equals(209)
    // A session id the game does not know is nobody in particular.
    expect(
      lineupOf(
        { ...lineups, home: { ...lineups.home, battingOrder: [99] } },
        'home',
        made.players
      ).batters
    ).deep.equals([{ userId: null, name: '', jersey: '' }])
    expect(lineupsOf).a('function')
  })
})

describe('a side left unseen', function () {
  const rosterOrder = (): ScoringAction => ({
    type: 'lineup',
    kind: 'roster',
    setup: setup(),
    unseen: ['away'],
    confirmed: ['home']
  })
  const swapped = (): GameSetup => {
    const made = setup()
    const order = made.sides.away.battingOrder
    made.sides.away.battingOrder = [order[1], order[0], ...order.slice(2)]
    return made
  }

  it('keeps the side when a later save confirms the same order', function () {
    const again = setup()
    expect([
      ...placeholderSidesOf([
        rosterOrder(),
        {
          type: 'lineup',
          kind: 'roster',
          setup: again,
          confirmed: ['away', 'home']
        }
      ])
    ]).deep.equals(['away'])
    expect(unseenLineup([rosterOrder()], 'away')).not.equals(null)
    expect(unseenLineup([rosterOrder()], 'home')).equals(null)
  })

  it('drops the side when a later save confirms a different order', function () {
    expect([
      ...placeholderSidesOf([
        rosterOrder(),
        {
          type: 'lineup',
          kind: 'roster',
          setup: swapped(),
          confirmed: ['away', 'home']
        }
      ])
    ]).deep.equals([])
  })

  it('confirms a side only once the save is no longer that order', function () {
    expect(confirmedSides([rosterOrder()], setup())).deep.equals(['home'])
    expect(confirmedSides([rosterOrder()], swapped())).deep.equals([
      'away',
      'home'
    ])
    expect(confirmedSides([], setup())).deep.equals(['away', 'home'])
  })

  it('keeps the side when a later save does not confirm it', function () {
    expect([
      ...placeholderSidesOf([
        rosterOrder(),
        { type: 'lineup', kind: 'roster', setup: swapped() }
      ])
    ]).deep.equals(['away'])
  })

  it('replays a shown roster only for a side still on the unseen order', function () {
    const start = freshGame('g1', TEAMS, setup())
    const blind = rosterOrder()
    const held = applyAction(start, blind)
    expect(held.problems).deep.equals([])
    const coachSetup = swapped()
    const coach: ScoringAction = {
      type: 'lineup',
      kind: 'roster',
      setup: coachSetup
    }
    const moved = applyAction(held.state, coach)
    expect(moved.problems).deep.equals([])
    const shownSetup = setup()
    const order = shownSetup.sides.away.battingOrder
    shownSetup.sides.away.battingOrder = [...order].reverse()
    const shown: ScoringAction = {
      type: 'lineup',
      kind: 'roster',
      setup: shownSetup,
      confirmed: ['away'],
      shown: true
    }
    // The visitors' coach already replaced that side, so the snapshot adds nothing.
    expect(reconcileShownLineup(shown, [blind, coach], moved.state)).equals(
      null
    )
    const open = reconcileShownLineup(shown, [blind], held.state)
    if (open?.type !== 'lineup' || open.setup == null) throw new Error('shown')
    expect(open.setup.sides.away.battingOrder).deep.equals(
      shownSetup.sides.away.battingOrder
    )
    expect(open.setup.sides.home.battingOrder).deep.equals(
      held.state.liveData.boxscore.teams.home.battingOrder
    )
    const { shown: _shown, ...sheet } = shown
    expect(reconcileShownLineup(sheet, [blind, coach], moved.state)).equals(
      sheet
    )
    const homeSetup = setup()
    const homeOrder = homeSetup.sides.home.battingOrder
    homeSetup.sides.home.battingOrder = [
      homeOrder[1],
      homeOrder[0],
      ...homeOrder.slice(2)
    ]
    const homeCoach: ScoringAction = {
      type: 'lineup',
      kind: 'roster',
      setup: homeSetup
    }
    const homeMoved = applyAction(held.state, homeCoach)
    expect(homeMoved.problems).deep.equals([])
    const bench = addPlayer(
      homeMoved.state,
      'home',
      9000000,
      'Home Bench',
      '99'
    )
    const kept = reconcileShownLineup(
      shown,
      [blind, homeCoach],
      homeMoved.state
    )
    if (kept?.type !== 'lineup' || kept.setup == null) throw new Error('kept')
    expect(kept.setup.sides.away.battingOrder).deep.equals(
      shownSetup.sides.away.battingOrder
    )
    expect(kept.setup.sides.home.battingOrder).deep.equals(
      homeSetup.sides.home.battingOrder
    )
    expect(kept.setup.sides.home.players).includes(bench)
    expect(kept.setup.players[bench].fullName).equals('Home Bench')
    expect(kept.confirmed).deep.equals(['away'])
  })
})
