import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { storedRecordOf } from '../../common/scoring/gumbo'
import { type EventStore, ScoringSession } from '../../common/scoring/session'
import {
  addGame,
  addScorableTeams,
  scratchDatabase
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { postGamePlays, readPlays } from './postPlays'

/** The server keeps each action's time exactly as the scorer sent it. */
describe('action times on the server (U4)', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  before(async function () {
    ;({ db, drop } = await scratchDatabase('action_times'))
  })
  after(async function () {
    await drop?.()
  })

  it('stores each play’s record, times and all, as it was posted', async function () {
    const context = await addScorableTeams(db, {
      home: 'Hawks',
      away: 'Gulls'
    })
    const gameId = await addGame(db, {
      homeTeamId: context.teams.home.id,
      awayTeamId: context.teams.away.id,
      startAt: new Date()
    })
    const load: EventStore['load'] = async id => {
      const game = await db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      return {
        plays: (await readPlays(db, id)).map(row => row.gumbo as GumboPlay),
        currentPlay: game.currentPlay as CurrentPlay | null
      }
    }
    const posted: unknown[] = []
    const store: EventStore = {
      load,
      save: async (id, change) => {
        posted.push(
          ...change.plays,
          ...(change.currentPlay == null ? [] : [change.currentPlay])
        )
        await postGamePlays(
          db,
          id,
          asPostEventsBody({
            ...change,
            mode: 'live',
            source: { system: 'teamstation' }
          })
        )
        return await load(id)
      }
    }
    let at = Date.parse('2026-09-25T18:00:00.123Z')
    const session = await ScoringSession.open(
      store,
      gameId,
      { gamePk: gameId, ...context },
      {
        now: () => new Date((at += 1500)),
        setTimer: () => null,
        clearTimer: () => undefined
      }
    )
    for (const action of [
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'C' },
      { type: 'result', eventType: 'single' },
      { type: 'pitch', call: 'F' }
    ] as const) {
      expect(session.apply(action).problems).deep.equals([])
      await session.flush()
    }
    const stored = await load(gameId)
    const records = [...stored.plays, stored.currentPlay].map(
      play => (play as { teamStation?: unknown }).teamStation
    )
    const sent = new Map(
      posted.map(play => [
        (play as GumboPlay).about.atBatIndex,
        (play as { teamStation?: unknown }).teamStation
      ])
    )
    expect(records).deep.equals([sent.get(0), sent.get(1)])
    expect(storedRecordOf(stored.plays[0])?.actionTimes).deep.equals([
      '2026-09-25T18:00:01.623Z',
      '2026-09-25T18:00:03.123Z',
      '2026-09-25T18:00:04.623Z'
    ])
    expect(storedRecordOf(stored.currentPlay)?.actionTimes).deep.equals([
      '2026-09-25T18:00:06.123Z'
    ])
  })
})
