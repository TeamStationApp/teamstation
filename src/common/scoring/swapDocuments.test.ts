import { expect } from 'chai'
import { describe, it } from 'mocha'

import { gameFixture } from '../../app/scoring/isUnscoredGame.test'
import { memoryStore } from '../../app/scoring/scoringSource'
import { scoringSession } from '../../test/scoringSession'
import { storedRecordOf } from './gumbo'
import { playsLost } from './playsLost'
import { ScoringSession } from './session'
import { swappedDocuments } from './swapDocuments'

/** A game scored for real: a strikeout, then a ball to the next batter. */
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
  return { plays: stored.plays, currentPlay: stored.currentPlay }
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
    // Records name teams, not sides: the plays read the same.
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
