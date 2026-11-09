import { expect } from 'chai'
import { describe, it } from 'mocha'

import { gameFixture } from '../../app/scoring/isUnscoredGame.test'
import { memoryStore } from '../../app/scoring/scoringSource'
import { scoringSession } from '../../test/scoringSession'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { recordOf, replayPlays, storedRecordOf } from './gumbo'
import { playsLost } from './playsLost'
import { ScoringSession } from './session'
import { setupOf } from './state'
import { swappedDocuments } from './swapDocuments'
import { playForWire } from './wireRecord'

/** The fixture's teams by side, and the same exchanged. */
const FIXTURE_TEAMS = {
  away: { id: gameFixture.awayTeamId, name: gameFixture.awayTeamName },
  home: { id: gameFixture.homeTeamId, name: gameFixture.homeTeamName }
}
const SWAPPED_TEAMS = { away: FIXTURE_TEAMS.home, home: FIXTURE_TEAMS.away }
/** A stored play or at-bat as the API answers it, and the phone keeps it. */
const wire = (play: unknown): unknown => playForWire(play, FIXTURE_TEAMS)

/**
 * A game scored for real, as the phone holds it from the API: a strikeout,
 * then a ball to the next batter, each record by side (version 2).
 */
async function scored(): Promise<{
  plays: unknown[]
  currentPlay: unknown
}> {
  const store = memoryStore()
  const session = ScoringSession.start(store, 'g1', scoringSession(gameFixture))
  for (const call of ['C', 'C', 'C', 'B'] as const)
    expect(session.apply({ type: 'pitch', call }).problems).deep.equals([])
  await session.flush()
  const stored = store.games.get('g1')!
  return {
    plays: stored.plays.map(wire),
    currentPlay: wire(stored.currentPlay)
  }
}

/**
 * A game whose lineups were saved before the first pitch, as the phone holds
 * it from the API: its at-bat a version 2 record, by side, the Owls (away)
 * batting 1–9 and the Hawks (home) 10–18.
 */
async function savedLineups(): Promise<{ currentPlay: unknown }> {
  const store = memoryStore()
  const session = ScoringSession.start(store, 'g1', scoringSession(gameFixture))
  const action: ScoringAction = {
    type: 'lineup',
    kind: 'roster',
    setup: setupOf(session.state),
    confirmed: ['away']
  }
  expect(session.apply(action).problems).deep.equals([])
  await session.flush()
  return { currentPlay: wire(store.games.get('g1')!.currentPlay) }
}

const NINE = (from: number): number[] =>
  Array.from({ length: 9 }, (_, i) => from + i)

/** Who bats first in the game the swapped documents open on. */
function leadoffOf(events: Record<string, unknown>): number | undefined {
  const plays = (events.plays as Array<{ gumbo: GumboPlay }>).map(
    row => row.gumbo
  )
  const { state } = replayPlays(
    { plays, currentPlay: events.currentPlay as CurrentPlay | null },
    {
      gamePk: 'g1',
      teams: SWAPPED_TEAMS,
      setup: setupOf(scoringSession(gameFixture))
    }
  )
  return state.liveData.linescore.offense.batter?.id
}

const record = (actions: unknown[]): Record<string, unknown> => ({
  version: 1,
  actions,
  actionTimes: actions.map((_, at) => `2026-11-09T18:0${at}:00Z`),
  playbackTimes: [],
  detail: { kept: false }
})

const lineup = { type: 'lineup', kind: 'roster' }
const pitch = { type: 'pitch', call: 'B' }

/** A plate appearance in `inning`, stored with TeamStation's record. */
const play = (atBatIndex: number, inning: number, tag?: string): unknown => ({
  about: { atBatIndex, inning, halfInning: 'top' },
  result: { eventType: 'single' },
  playEvents: [{ isPitch: true }],
  teamStation: record(atBatIndex === 0 ? [lineup, pitch] : [pitch]),
  ...(tag == null
    ? {}
    : {
        tagTargets: {
          version: 1,
          play: { id: `t${atBatIndex}`, signature: 's', tag },
          events: []
        }
      })
})

const game = {
  id: 'g1',
  homeTeamId: 'tem_home',
  awayTeamId: 'tem_away',
  homeTeamName: 'Hawks',
  awayTeamName: 'Owls',
  homeTeamExternal: false,
  awayTeamExternal: true,
  homeScore: 3,
  awayScore: 1,
  status: 'inProgress',
  generation: 4,
  guestPlayers: { away: [{ gumboId: 7 }], home: [{ gumboId: 8 }] },
  unrostered: { away: [1], home: [] },
  coachSides: ['home'],
  linescore: { away: { runs: 1 }, home: { runs: 3 } }
}

const side = (teamId: string): Record<string, unknown> => ({
  teamId,
  teamName: teamId,
  start: { batters: [teamId] },
  changes: [{ at: 1 }],
  current: { batters: [`${teamId}-now`] }
})

const lineups = {
  away: side('tem_away'),
  home: side('tem_home'),
  digest: 'L1',
  generation: 4
}

const events = {
  plays: [
    { id: 'e0', gameId: 'g1', gumbo: play(0, 1, 'great catch') },
    { id: 'e1', gameId: 'g1', gumbo: play(1, 2) }
  ],
  currentPlay: null,
  playsDigest: 'P1',
  priorPlaysDigest: 'P0',
  lineupsDigest: 'L1',
  generation: 4,
  swap: 'reset'
}

describe('swappedDocuments', function () {
  it('exchanges the sides, the guest players and the lineups, and keeps the plays', function () {
    const done = swappedDocuments({ game, lineups, events }, 'swap', 'local-1')
    expect(done.game).deep.include({
      homeTeamId: 'tem_away',
      awayTeamId: 'tem_home',
      homeTeamName: 'Owls',
      awayTeamName: 'Hawks',
      homeTeamExternal: true,
      awayTeamExternal: false,
      homeScore: 1,
      awayScore: 3,
      generation: 4,
      status: 'inProgress'
    })
    expect(done.game.guestPlayers).deep.equals({
      away: [{ gumboId: 8 }],
      home: [{ gumboId: 7 }]
    })
    expect(done.game.unrostered).deep.equals({ away: [], home: [1] })
    // A list of sides, not kept by side, stays as it is.
    expect(done.game.coachSides).deep.equals(['home'])
    expect(done.lineups).deep.equals({
      away: side('tem_home'),
      home: side('tem_away'),
      digest: 'local-1',
      generation: 4
    })
    // Records with no lineups to carry read the same.
    expect(done.events).deep.equals({ ...events, lineupsDigest: 'local-1' })
    expect(done.answer).deep.equals({
      homeTeamId: 'tem_away',
      awayTeamId: 'tem_home',
      generation: 4,
      reset: { atBats: 0, innings: 0 }
    })
  })

  it('on a reset also empties the plays and their tags, rewinds the game, and advances its generation', function () {
    const done = swappedDocuments({ game, lineups, events }, 'reset', 'local-2')
    expect(done.game).deep.include({
      homeTeamId: 'tem_away',
      awayTeamId: 'tem_home',
      generation: 5,
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      linescore: null
    })
    expect(done.lineups).deep.equals({
      away: {
        ...side('tem_home'),
        start: null,
        changes: [],
        current: { batters: ['tem_home'] }
      },
      home: {
        ...side('tem_away'),
        start: null,
        changes: [],
        current: { batters: ['tem_away'] }
      },
      digest: 'local-2',
      generation: 5
    })
    const reset = done.events!
    expect(reset.plays).deep.equals([])
    expect(JSON.stringify(reset)).not.includes('great catch')
    expect(reset).deep.include({
      playsDigest: null,
      priorPlaysDigest: null,
      lineupsDigest: 'local-2',
      generation: 5,
      swap: 'swap'
    })
    // These plays carry no record a reader takes up: nothing to rewind to.
    expect(reset.currentPlay).equals(null)
    expect(done.answer).deep.equals({
      homeTeamId: 'tem_away',
      awayTeamId: 'tem_home',
      generation: 5,
      reset: { atBats: 2, innings: 2 }
    })
  })

  it('rewinds a reset to the lineups the first TeamStation record began with', async function () {
    const stored = await scored()
    const first = stored.plays[0] as { teamStation: { actions: unknown[] } }
    const done = swappedDocuments(
      {
        game,
        lineups: null,
        events: {
          plays: stored.plays.map(gumbo => ({ gumbo })),
          currentPlay: stored.currentPlay
        }
      },
      'reset',
      'local-r'
    )
    const pregame = (done.events!.currentPlay as { teamStation: unknown })
      .teamStation as { actions: Array<{ type: string }> }
    // Only the lineup actions before the first pitch, as the server keeps.
    expect(pregame.actions.every(action => action.type === 'lineup')).equals(
      true
    )
    expect(pregame.actions.length).lessThan(first.teamStation.actions.length)
    expect(pregame).not.have.property('playbackTimes')
    expect(storedRecordOf(done.events!.currentPlay)).not.equals(null)
    expect(done.answer.reset).deep.equals(playsLost(stored))
  })

  it('puts each team’s saved lineups on its new side in the at-bat the phone holds by side, as the server answers it after a swap', async function () {
    const stored = await savedLineups()
    const was = recordOf(stored.currentPlay, FIXTURE_TEAMS)!
    expect(was.setupBefore.sides.away.battingOrder).deep.equals(NINE(1))
    const done = swappedDocuments(
      {
        game: { ...gameFixture },
        lineups: null,
        events: { plays: [], currentPlay: stored.currentPlay }
      },
      'swap',
      'local-s'
    )
    const now = recordOf(done.events!.currentPlay, SWAPPED_TEAMS)!
    expect(now.setupBefore.sides.away).deep.equals(was.setupBefore.sides.home)
    expect(now.setupBefore.sides.home).deep.equals(was.setupBefore.sides.away)
    expect(now.setupBefore.sides.away.battingOrder).deep.equals(NINE(10))
    const [saved] = now.actions as Array<{
      setup: { sides: typeof now.setupBefore.sides }
      confirmed: string[]
    }>
    expect(saved.setup.sides.away.battingOrder).deep.equals(NINE(10))
    expect(saved.setup.sides.home.battingOrder).deep.equals(NINE(1))
    // The Owls confirmed theirs, and they are home now.
    expect(saved.confirmed).deep.equals(['home'])
    // Still by side, as the API carries it.
    expect(done.events!.currentPlay).nested.property('teamStation.version', 2)
    // The Hawks, away now, bat first.
    expect(leadoffOf(done.events!)).equals(10)
  })

  it('exchanges the sides of every stored play’s record on a swap', async function () {
    const stored = await scored()
    const done = swappedDocuments(
      {
        game: { ...gameFixture },
        lineups: null,
        events: {
          plays: stored.plays.map(gumbo => ({ id: 'e', gumbo })),
          currentPlay: stored.currentPlay
        }
      },
      'swap',
      'local-p'
    )
    const rows = done.events!.plays as Array<{ id: string; gumbo: unknown }>
    expect(rows.map(row => row.id)).deep.equals(stored.plays.map(() => 'e'))
    for (const [i, row] of rows.entries()) {
      const before = recordOf(stored.plays[i], FIXTURE_TEAMS)!.setupBefore
      const after = recordOf(row.gumbo, SWAPPED_TEAMS)!.setupBefore
      expect(after.sides).deep.equals({
        away: before.sides.home,
        home: before.sides.away
      })
    }
    expect(
      recordOf(done.events!.currentPlay, SWAPPED_TEAMS)!.setupBefore.sides.home
        .battingOrder
    ).deep.equals(NINE(1))
  })

  it('on a Reset and Swap rewinds to each team’s lineups on its new side', async function () {
    const stored = await scored()
    const done = swappedDocuments(
      {
        game: { ...gameFixture },
        lineups: null,
        events: {
          plays: stored.plays.map(gumbo => ({ gumbo })),
          currentPlay: stored.currentPlay
        }
      },
      'reset',
      'local-q'
    )
    expect(done.events!.plays).deep.equals([])
    const pregame = recordOf(done.events!.currentPlay, SWAPPED_TEAMS)!
    expect(pregame.setupBefore.sides.away.battingOrder).deep.equals(NINE(10))
    expect(pregame.setupBefore.sides.home.battingOrder).deep.equals(NINE(1))
    expect(leadoffOf(done.events!)).equals(10)
  })

  it('names the at-bats and innings a reset loses as playsLost counts the stored plays', function () {
    const stored = {
      plays: [play(0, 1), play(1, 1), play(2, 3)],
      currentPlay: { about: { atBatIndex: 3, inning: 3 }, playEvents: [{}] }
    }
    const done = swappedDocuments(
      {
        game,
        lineups: null,
        events: {
          plays: stored.plays.map(gumbo => ({ gumbo })),
          currentPlay: stored.currentPlay
        }
      },
      'reset',
      'local-3'
    )
    expect(done.answer.reset).deep.equals(playsLost(stored))
    expect(done.answer.reset.atBats).greaterThan(0)
    expect(done.lineups).equals(null)
  })

  it('swaps what it is given: no lineups or plays, a cancelled game, a game with no generation, plays with no record', function () {
    const bare = {
      homeTeamId: 'a',
      awayTeamId: 'b',
      status: 'cancelled'
    }
    const swapped = swappedDocuments(
      { game: bare, lineups: null, events: null },
      'swap',
      'x'
    )
    expect(swapped.game).deep.equals({
      homeTeamId: 'b',
      awayTeamId: 'a',
      status: 'cancelled'
    })
    expect(swapped.events).equals(null)
    expect(swapped.answer.generation).equals(0)
    const reset = swappedDocuments(
      {
        game: bare,
        lineups: {
          away: null,
          home: { start: null, current: null },
          digest: 'd'
        },
        events: { plays: [{ gumbo: { about: { atBatIndex: 0, inning: 1 } } }] }
      },
      'reset',
      'y'
    )
    expect(reset.game).deep.include({ status: 'cancelled', generation: 1 })
    // Home's lineups are away's now; a side with none stays none.
    expect(reset.lineups).deep.include({
      home: null,
      away: { start: null, changes: [], current: null },
      generation: 1
    })
    // Nothing TeamStation scored: no lineups to rewind to.
    expect(reset.events).deep.include({ plays: [], currentPlay: null })
  })
})
