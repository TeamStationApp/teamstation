import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import {
  databaseUrlOf,
  listenScreenScopes,
  openScopeSocket,
  type ScopeSocket,
  type ScreenScopeNotices
} from '../../test/screenScopeNotices'
import { attachGameSocket, type GameSocketHandle } from './gameSocket'
import { REVISION_HEADER } from './syncRevision'

/**
 * The writes that change what home, schedule and an event show, each heard
 * on `screen_scopes` with the id the worker matches on, at the revision its
 * own transaction took. A write that fails tells nobody.
 *
 * The fixture's people: 101 runs league, season and team A; 102 runs B; 103
 * runs the standalone season and team; 104 belongs to nothing.
 */
describe('notices from the writes', function () {
  this.timeout(60000)
  let f: GroupFixture
  let notices: ScreenScopeNotices
  let server: Server
  let socket: GameSocketHandle
  let socketUrl = ''
  const sockets: ScopeSocket[] = []
  const gameId = makeId('game')
  /** A game nobody has scored. */
  const unscored = makeId('game')
  const user = (id: number): string => userIdOfGumbo(id)

  before(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('games')
      .values(
        [gameId, unscored].map(id => ({
          id,
          home_team_id: f.teamA,
          away_team_id: f.standaloneTeam,
          season_id: f.seasonA,
          start_at: new Date(Date.now() + 3_600_000)
        }))
      )
      .execute()
    notices = await listenScreenScopes(f.h.db)
    server = createServer()
    socket = attachGameSocket(server, f.h.db, await databaseUrlOf(f.h.db), {
      pingMs: 60_000,
      stopSignals: null,
      log: () => undefined,
      fanout: { log: () => undefined },
      screenScopes: { log: () => undefined }
    })
    await socket.fanout.listening
    await socket.screenScopes.listening
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    socketUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket`
  })

  after(async () => {
    for (const each of sockets) each.close()
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

  const ok = async (
    method: string,
    path: string,
    body: unknown,
    by: number
  ): Promise<Response> => {
    const response = await f.h.request(method, path, body, by)
    expect(
      response.status,
      `${method} ${path}: ${await response.clone().text()}`
    ).lessThan(300)
    return response
  }

  const livePost = (homeScore: number): object => ({
    mode: 'live',
    source: { system: 'manual' },
    plays: [],
    currentPlay: {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top', isComplete: false },
      result: { awayScore: 0, homeScore }
    }
  })

  const scopeSocket = async (by: number): Promise<ScopeSocket> => {
    const opened = await openScopeSocket(socketUrl, f.h.tokens.get(by)!)
    sockets.push(opened)
    return opened
  }

  /** Long enough for the worker's window to have passed. */
  const quiet = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 400))
  }

  it('tells a live play’s game, at the revision a later read of it answers (Commit order)', async function () {
    const mark = notices.mark()
    await ok('POST', `/games/${gameId}/events`, livePost(0), 101)
    const notice = await notices.named(mark, { gameId })
    const read = await f.h.request(
      'GET',
      `/games/${gameId}/lineups`,
      undefined,
      101
    )
    expect(read.status).equals(200)
    expect(read.headers.get(REVISION_HEADER)).equals(notice.revision)
  })

  it('tells nobody of a write that fails (Rollback)', async function () {
    const mark = notices.mark()
    const refused = await f.h.request(
      'PUT',
      `/groups/team/${f.teamA}`,
      { name: 'Demo Renamed', locality: { nonsense: true } },
      101
    )
    expect(refused.status).equals(400)
    expect(await notices.since(mark)).deep.equals([])
  })

  it('tells the game of a guest player and of a moved event', async function () {
    const mark = notices.mark()
    await ok(
      'POST',
      `/games/${unscored}/guest-players`,
      {
        side: 'home',
        firstName: 'Ichiro',
        lastName: 'Suzuki',
        jersey: '51',
        positions: [],
        bats: null,
        throws: null
      },
      101
    )
    await ok(
      'PUT',
      `/events/${unscored}/info`,
      { address: '1 Demo Field Way' },
      101
    )
    const heard = await notices.since(mark)
    expect(heard.length).equals(2)
    for (const payload of heard)
      expect(payload).deep.equals({
        revision: payload.revision,
        gameId: unscored
      })
  })

  it('tells a team’s schedule of a team event made and moved', async function () {
    let mark = notices.mark()
    const made = await ok(
      'POST',
      '/events',
      {
        teamId: f.teamA,
        eventType: 'practice',
        startAt: new Date(Date.UTC(2027, 3, 2, 17)).toISOString(),
        timezone: 'UTC',
        venue: null,
        status: 'scheduled',
        idempotencyKey: 'writer-notices-practice'
      },
      101
    )
    const { id } = (await made.json()) as { id: string }
    await notices.named(mark, { teamId: f.teamA })
    mark = notices.mark()
    await ok('PUT', `/events/${id}/info`, { venue: 'Demo Field' }, 101)
    await notices.named(mark, { teamId: f.teamA })
  })

  it('tells a new game’s schedule', async function () {
    const mark = notices.mark()
    const made = await ok(
      'POST',
      `/teams/${f.teamA}/games`,
      {
        games: [
          {
            opponent: { name: 'Demo Opponent' },
            side: 'home',
            seasonId: f.seasonA,
            startAt: new Date(Date.UTC(2027, 3, 1, 17)).toISOString()
          }
        ]
      },
      101
    )
    const created = (
      (await made.json()) as {
        results: Array<{ result: string; gameId: string }>
      }
    ).results[0]
    expect(created.result).equals('created')
    await notices.named(mark, { gameId: created.gameId })
  })

  it('tells a team’s rename to a schedule that sees the team, and to no other (Team rename)', async function () {
    const sees = await scopeSocket(101)
    const others = await scopeSocket(102)
    const nobody = await scopeSocket(104)
    for (const each of [sees, others, nobody])
      expect(
        await each.ask({ type: 'subscribe', scope: 'schedule' })
      ).deep.include({ type: 'subscribed' })
    // What earlier tests committed has been told by now.
    await quiet()
    const from = [sees, others, nobody].map(each => each.frames.length)
    const mark = notices.mark()
    await ok('PUT', `/groups/team/${f.teamA}`, { name: 'Demo Falcons' }, 101)
    const notice = await notices.named(mark, { teamId: f.teamA })
    await quiet()
    expect(sees.changes(from[0])).deep.equals([
      { type: 'changed', scope: 'schedule', revision: notice.revision }
    ])
    expect(others.changes(from[1])).deep.equals([])
    expect(nobody.changes(from[2])).deep.equals([])
  })

  it('tells the receiving team’s schedule of a new game proposed to it, and of its withdrawal', async function () {
    const receiving = await scopeSocket(102)
    expect(
      await receiving.ask({ type: 'subscribe', scope: 'schedule' })
    ).deep.include({ type: 'subscribed' })
    await quiet()
    let from = receiving.frames.length
    let mark = notices.mark()
    const proposed = await ok(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: null,
          startAt: '2027-04-02T19:00:00Z',
          status: 'scheduled',
          venue: 'Demo Notice Park'
        },
        idempotencyKey: 'writer-notices-proposal'
      },
      101
    )
    const request = (await proposed.json()) as {
      id: string
      status: string
      gameId: string | null
    }
    // Still a proposal: there is no game row for its id to be matched on.
    expect(request.status).equals('pending')
    expect(request.gameId).equals(null)
    let notice = await notices.named(mark, { teamId: f.teamB })
    await quiet()
    expect(receiving.changes(from)).deep.include({
      type: 'changed',
      scope: 'schedule',
      revision: notice.revision
    })
    from = receiving.frames.length
    mark = notices.mark()
    await ok('POST', `/game-requests/${request.id}/withdraw`, {}, 101)
    notice = await notices.named(mark, { teamId: f.teamB })
    await quiet()
    expect(receiving.changes(from)).deep.include({
      type: 'changed',
      scope: 'schedule',
      revision: notice.revision
    })
  })

  it('tells a game’s teams and season when it goes final, and not of a play before', async function () {
    const finalGame = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id: finalGame,
        home_team_id: f.teamA,
        away_team_id: f.standaloneTeam,
        season_id: f.seasonA,
        start_at: new Date(Date.now() - 3_600_000)
      })
      .execute()
    const play = (atBatIndex: number, homeScore: number): object => ({
      about: { atBatIndex, inning: 1, halfInning: 'top', isScoringPlay: false },
      count: { outs: 1 },
      result: {
        eventType: 'single',
        awayScore: 0,
        homeScore,
        description: 'Single'
      },
      playEvents: [{ isPitch: true }]
    })
    // A live play: the game's own screens only, not its teams' records.
    let mark = notices.mark()
    await ok(
      'POST',
      `/games/${finalGame}/events`,
      { mode: 'live', source: { system: 'manual' }, plays: [play(0, 0)] },
      101
    )
    const played = await notices.since(mark)
    expect(played.map(payload => payload.gameId)).deep.equals([finalGame])
    expect(played.filter(payload => payload.teamId != null)).deep.equals([])
    // The game arriving whole, with both scores: it is final, and its teams'
    // records and its season move.
    mark = notices.mark()
    await ok(
      'POST',
      `/games/${finalGame}/events`,
      { source: { system: 'manual' }, plays: [play(0, 0), play(1, 3)] },
      101
    )
    const row = await f.h.db
      .selectFrom('games')
      .select('status')
      .where('id', '=', finalGame)
      .executeTakeFirstOrThrow()
    expect(row.status).equals('final')
    for (const ids of [
      { gameId: finalGame },
      { teamId: f.teamA },
      { teamId: f.standaloneTeam },
      { seasonId: f.seasonA }
    ])
      await notices.named(mark, ids)
  })

  it('tells only those who can see a game of its play (Visibility)', async function () {
    const event = await scopeSocket(101)
    const home = await scopeSocket(103)
    const stranger = await scopeSocket(104)
    expect(
      await event.ask({ type: 'subscribe', scope: 'event', gameId })
    ).deep.include({ type: 'subscribed', scope: 'event' })
    expect(await home.ask({ type: 'subscribe', scope: 'home' })).deep.include({
      type: 'subscribed'
    })
    expect(
      await stranger.ask({ type: 'subscribe', scope: 'schedule' })
    ).deep.include({ type: 'subscribed' })
    await quiet()
    const from = [event, home, stranger].map(each => each.frames.length)
    const mark = notices.mark()
    await ok('POST', `/games/${gameId}/events`, livePost(1), 101)
    const notice = await notices.named(mark, { gameId })
    await quiet()
    expect(event.changes(from[0])).deep.equals([
      { type: 'changed', scope: 'event', revision: notice.revision, gameId }
    ])
    // The away side's administrator sees the game too.
    expect(home.changes(from[1])).deep.equals([
      { type: 'changed', scope: 'home', revision: notice.revision, gameId }
    ])
    expect(stranger.changes(from[2])).deep.equals([])
  })

  it('sends two plays inside the window as one changed, at the later revision (Coalesce)', async function () {
    const event = await scopeSocket(103)
    expect(
      await event.ask({ type: 'subscribe', scope: 'event', gameId })
    ).deep.include({ type: 'subscribed', scope: 'event' })
    await quiet()
    const from = event.frames.length
    const mark = notices.mark()
    await Promise.all([
      ok('POST', `/games/${gameId}/events`, livePost(2), 101),
      ok('POST', `/games/${gameId}/events`, livePost(3), 101)
    ])
    const heard = await notices.since(mark)
    expect(heard.map(payload => payload.gameId)).deep.equals([gameId, gameId])
    await quiet()
    expect(event.changes(from)).deep.equals([
      { type: 'changed', scope: 'event', revision: heard[1].revision, gameId }
    ])
  })

  it('tells a person and the team of a membership given and taken away', async function () {
    let mark = notices.mark()
    await ok(
      'POST',
      `/manage/team/${f.teamA}/people`,
      { email: 'fixture104@example.com', admin: false, flags: [] },
      101
    )
    await notices.named(mark, { userId: user(104), teamId: f.teamA })
    mark = notices.mark()
    await ok('DELETE', `/me/groups/team/${f.teamA}`, undefined, 104)
    await notices.named(mark, { userId: user(104), teamId: f.teamA })
  })

  it('tells a follower of a follow and an unfollow, and nothing of one already held', async function () {
    let mark = notices.mark()
    await ok('PUT', `/me/follows/team/${f.teamB}`, undefined, 104)
    await notices.named(mark, { userId: user(104), teamId: f.teamB })
    mark = notices.mark()
    await ok('PUT', `/me/follows/team/${f.teamB}`, undefined, 104)
    expect(await notices.since(mark)).deep.equals([])
    mark = notices.mark()
    await ok('DELETE', `/me/follows/season/${f.seasonB}`, undefined, 104)
    expect(await notices.since(mark)).deep.equals([])
    await ok('DELETE', `/me/follows/team/${f.teamB}`, undefined, 104)
    await notices.named(mark, { userId: user(104), teamId: f.teamB })
  })

  it('tells the maker of a new team, and both sides of a team leaving a season', async function () {
    let mark = notices.mark()
    const made = await ok(
      'POST',
      '/teams',
      {
        name: 'Demo Owls',
        idempotencyKey: 'writer-notices-team',
        locality: demoLocality
      },
      103
    )
    const { id } = (await made.json()) as { id: string }
    await notices.named(mark, { userId: user(103), teamId: id })
    mark = notices.mark()
    await ok(
      'DELETE',
      `/seasons/${f.seasonA}/memberships/${f.teamA}`,
      undefined,
      101
    )
    await notices.named(mark, { seasonId: f.seasonA, teamId: f.teamA })
  })

  it('tells the game of its fence set', async function () {
    const mark = notices.mark()
    await ok('PUT', `/games/${unscored}/field`, { fenceDistanceFt: 210 }, 101)
    await notices.named(mark, { gameId: unscored })
  })
})
