import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import {
  databaseUrlOf,
  listenScreenScopes,
  openScopeSocket,
  type ScopeSocket,
  type ScreenScopeNotices
} from '../../test/screenScopeNotices'
import { attachGameSocket, type GameSocketHandle } from './gameSocket'
import { readSyncClock } from './syncRevision'

/**
 * S2: an event's screen hears of the live play that committed, and of
 * nothing from the post that rolled back.
 *
 * The second post fails a constraint that is checked as its transaction
 * commits, after the clock was bumped and `screen_scopes` notified, so the
 * notify was sent and still never reaches anybody. Each step is printed, so
 * the run is its own log.
 */
describe('S2: one changed for the committed play, none for the rolled-back post', function () {
  this.timeout(60000)
  let f: GroupFixture
  let server: Server
  let socket: GameSocketHandle
  let notices: ScreenScopeNotices
  let viewer: ScopeSocket | undefined
  const gameId = makeId('game')
  let started = 0
  const note = (line: string): void => {
    console.log(`      ${String(Date.now() - started).padStart(5)}ms ${line}`)
  }

  before(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date(Date.now() + 3_600_000)
      })
      .execute()
    // The forced failure: a home score of 99 breaks a constraint checked at
    // commit, when every statement of the post, the clock's among them, ran.
    await sql`
      create function no_ninety_nine() returns trigger language plpgsql as $$
      begin
        if new.home_score = 99 then
          raise exception 'a home score of 99 is refused'
            using errcode = 'check_violation';
        end if;
        return null;
      end $$`.execute(f.h.db)
    await sql`
      create constraint trigger no_ninety_nine after update on games
      deferrable initially deferred for each row
      execute function no_ninety_nine()`.execute(f.h.db)
    notices = await listenScreenScopes(f.h.db)
    server = createServer()
    socket = attachGameSocket(server, f.h.db, await databaseUrlOf(f.h.db), {
      pingMs: 60_000,
      stopSignals: null,
      log: () => undefined,
      fanout: { log: () => undefined }
    })
    await socket.fanout.listening
    await socket.screenScopes.listening
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    started = Date.now()
  })

  after(async () => {
    viewer?.close()
    await socket?.close()
    await new Promise<void>(resolve => {
      server?.close(() => {
        resolve()
      })
      server?.closeAllConnections()
    })
    await notices?.close()
    await f?.h.close()
  })

  const post = async (homeScore: number): Promise<Response> =>
    await f.h.request(
      'POST',
      `/games/${gameId}/events`,
      {
        mode: 'live',
        source: { system: 'manual' },
        plays: [
          {
            about: {
              atBatIndex: 0,
              inning: 1,
              halfInning: 'top',
              isScoringPlay: homeScore > 0
            },
            count: { outs: 1 },
            result: {
              eventType: 'single',
              awayScore: 0,
              homeScore,
              description: 'Single'
            },
            playEvents: [{ isPitch: true }]
          }
        ]
      },
      101
    )

  /** The worker holds a notice 250ms; this is well past it. */
  const window = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 600))
  }

  it('tells the event once of the play that committed, and never of the one rolled back', async function () {
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket`
    viewer = await openScopeSocket(url, f.h.tokens.get(102)!)
    const subscribed = await viewer.ask({
      type: 'subscribe',
      scope: 'event',
      gameId
    })
    expect(subscribed).deep.include({ type: 'subscribed', scope: 'event' })
    note(`← ${JSON.stringify(subscribed)}`)

    const before = await readSyncClock(f.h.db)
    let mark = notices.mark()
    note('→ POST live play, home 1')
    const committed = await post(1)
    note(`← ${committed.status} POST live play`)
    expect(committed.status).equals(200)
    const notice = await notices.named(mark, { gameId })
    note(`  screen_scopes notified at revision ${notice.revision}`)
    expect(BigInt(notice.revision)).equals(BigInt(before) + 1n)
    await window()
    const told = viewer.changes()
    for (const frame of told) note(`← ${JSON.stringify(frame)}`)
    expect(told).deep.equals([
      { type: 'changed', scope: 'event', revision: notice.revision, gameId }
    ])

    mark = notices.mark()
    const from = viewer.frames.length
    note('→ POST live play, home 99 (refused as it commits)')
    const refused = await post(99)
    note(`← ${refused.status} POST live play`)
    expect(refused.status).equals(500)
    await window()
    const heard = await notices.since(mark)
    note(`  screen_scopes notices since: ${JSON.stringify(heard)}`)
    expect(heard).deep.equals([])
    const after = viewer.changes(from)
    note(`  changed frames since: ${JSON.stringify(after)}`)
    expect(after).deep.equals([])
    // Nor did it write: the game keeps the play that committed.
    const stored = await f.h.db
      .selectFrom('games')
      .select('home_score')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    note(`  the game still reads home ${String(stored.home_score)}`)
    expect(stored.home_score).equals(1)
  })
})
