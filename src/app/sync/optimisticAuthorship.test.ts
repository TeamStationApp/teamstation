import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ScoringSession } from '../../common/scoring/session'
import { playForWire } from '../../common/scoring/wireRecord'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { memoryStore } from '../scoring/scoringSource'
import { appliedEvents } from './optimistic'

const TEAMS = {
  away: { id: gameFixture.awayTeamId, name: gameFixture.awayTeamName },
  home: { id: gameFixture.homeTeamId, name: gameFixture.homeTeamName }
}
/** A stored play or at-bat as the API answers it, and the phone keeps it. */
const wire = (play: unknown): unknown => playForWire(play, TEAMS)
const game = {
  gameId: 'g1',
  plays: 'local',
  lineups: null,
  newPlayId: () => 'row-new'
}

/**
 * A strikeout, then a ball to the next batter, as the server answered it,
 * with who scored each record action; and the next batter's at-bat once the
 * phone has added a strike to it, the ball the same action as the server's.
 */
async function answered(): Promise<{
  stored: Record<string, unknown>
  withStrike: unknown
}> {
  const store = memoryStore()
  const session = ScoringSession.start(store, 'g1', scoringSession(gameFixture))
  for (const call of ['C', 'C', 'C', 'B'] as const)
    expect(session.apply({ type: 'pitch', call }).problems).deep.equals([])
  await session.flush()
  const saved = structuredClone(store.games.get('g1')!)
  expect(session.apply({ type: 'pitch', call: 'S' }).problems).deep.equals([])
  await session.flush()
  return {
    stored: {
      plays: saved.plays.map((play, i) => ({
        id: `row-${i}`,
        gumbo: wire(play)
      })),
      currentPlay: wire(saved.currentPlay),
      scoringAuthorship: {
        plays: { '0': ['u1', 'u1', 'u1'], '1': ['u2'] },
        removals: [],
        names: { u1: 'Pat', u2: 'Sam' }
      }
    },
    withStrike: wire(store.games.get('g1')!.currentPlay)
  }
}

const authorsOf = (events: Record<string, unknown>): unknown =>
  (events.scoringAuthorship as { plays: unknown }).plays

describe("the phone's own plays and the server's authorship", function () {
  it('keeps the authors of an at-bat left alone and of the actions a rewritten one kept, and credits nobody with what the phone added', async function () {
    const { stored, withStrike } = await answered()
    const applied = appliedEvents(
      stored,
      { plays: [], remove: [], currentPlay: withStrike },
      game
    )
    expect(authorsOf(applied)).deep.equals({
      '0': ['u1', 'u1', 'u1'],
      '1': ['u2']
    })
    expect((applied.scoringAuthorship as { names: unknown }).names).deep.equals(
      {
        u1: 'Pat',
        u2: 'Sam'
      }
    )
  })

  it("never moves an author onto an action the phone put in another's place", async function () {
    // The server's at-bat: a ball by Sam, then a strike by Lee. The phone
    // took the strike back and put its own ball where it was.
    const store = memoryStore()
    const session = ScoringSession.start(
      store,
      'g1',
      scoringSession(gameFixture)
    )
    for (const call of ['C', 'C', 'C', 'B', 'S'] as const)
      expect(session.apply({ type: 'pitch', call }).problems).deep.equals([])
    await session.flush()
    const saved = structuredClone(store.games.get('g1')!)
    expect(session.undo().problems).deep.equals([])
    expect(session.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    await session.flush()
    const applied = appliedEvents(
      {
        plays: saved.plays.map((play, i) => ({
          id: `row-${i}`,
          gumbo: wire(play)
        })),
        currentPlay: wire(saved.currentPlay),
        scoringAuthorship: {
          plays: { '0': ['u1', 'u1', 'u1'], '1': ['u2', 'u3'] },
          removals: [],
          names: { u1: 'Pat', u2: 'Sam', u3: 'Lee' }
        }
      },
      {
        plays: [],
        remove: [],
        currentPlay: wire(store.games.get('g1')!.currentPlay)
      },
      game
    )
    expect(authorsOf(applied)).deep.equals({
      '0': ['u1', 'u1', 'u1'],
      '1': ['u2']
    })
  })

  it('drops the authors of an at-bat the phone removed', async function () {
    const { stored } = await answered()
    const applied = appliedEvents(
      stored,
      { plays: [], remove: [0], currentPlay: stored.currentPlay },
      game
    )
    expect(authorsOf(applied)).deep.equals({ '1': ['u2'] })
  })

  it('drops the authors of an at-bat whose first action the phone replaced', async function () {
    const { stored } = await answered()
    const store = memoryStore()
    const session = ScoringSession.start(
      store,
      'g1',
      scoringSession(gameFixture)
    )
    for (const call of ['C', 'C', 'C', 'S'] as const)
      expect(session.apply({ type: 'pitch', call }).problems).deep.equals([])
    await session.flush()
    const applied = appliedEvents(
      stored,
      {
        plays: [],
        remove: [],
        currentPlay: wire(store.games.get('g1')!.currentPlay)
      },
      game
    )
    expect(authorsOf(applied)).deep.equals({ '0': ['u1', 'u1', 'u1'] })
  })

  it('leaves events with no authorship without any', async function () {
    const { stored, withStrike } = await answered()
    const { scoringAuthorship: _authorship, ...plain } = stored
    const applied = appliedEvents(
      plain,
      { plays: [], remove: [], currentPlay: withStrike },
      game
    )
    expect(applied).not.has.property('scoringAuthorship')
  })
})
