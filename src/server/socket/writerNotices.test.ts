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
  announcedDuring,
  databaseUrlOf,
  listenScreenScopes,
  openScopeSocket,
  type ScopeSocket,
  type ScreenScopeNotices
} from '../../test/screenScopeNotices'
import { attachGameSocket, type GameSocketHandle } from './gameSocket'

/**
 * The writes that change what home, schedule and an event show, each heard
 * on `screen_scopes` with the id the worker matches on, once its own
 * transaction commits. A write that fails tells nobody.
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

  /** A post that moves the game to `inning`, past the 1st: a change its lists show. */
  const livePost = (inning: number): object => ({
    mode: 'live',
    source: { system: 'manual' },
    plays: [],
    currentPlay: {
      about: { atBatIndex: 0, inning, halfInning: 'top', isComplete: false },
      result: { awayScore: 0, homeScore: 0 }
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

  it('tells a live play’s game, with no revision, committed before a later read of it (Commit order)', async function () {
    const mark = notices.mark()
    await ok('POST', `/games/${gameId}/events`, livePost(2), 101)
    const notice = await notices.named(mark, { gameId })
    expect(notice).deep.equals({ gameId, byPost: true })
    const read = await f.h.request(
      'GET',
      `/games/${gameId}/lineups`,
      undefined,
      101
    )
    expect(read.status).equals(200)
    // A list read takes no revision, and says none.
    expect(read.headers.get('x-teamstation-revision')).equals(null)
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
      expect(payload).deep.equals({ gameId: unscored })
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
    await notices.named(mark, { teamId: f.teamA })
    await quiet()
    expect(sees.changes(from[0])).deep.equals([
      { type: 'changed', scope: 'schedule' }
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
    await notices.named(mark, { teamId: f.teamB })
    await quiet()
    expect(receiving.changes(from)).deep.include({
      type: 'changed',
      scope: 'schedule'
    })
    from = receiving.frames.length
    mark = notices.mark()
    await ok('POST', `/game-requests/${request.id}/withdraw`, {}, 101)
    await notices.named(mark, { teamId: f.teamB })
    await quiet()
    expect(receiving.changes(from)).deep.include({
      type: 'changed',
      scope: 'schedule'
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
    await ok('POST', `/games/${gameId}/events`, livePost(3), 101)
    await notices.named(mark, { gameId })
    await quiet()
    expect(event.changes(from[0])).deep.equals([
      { type: 'changed', scope: 'event', gameId, byPost: true }
    ])
    // The away side's administrator sees the game too.
    expect(home.changes(from[1])).deep.equals([
      { type: 'changed', scope: 'home', gameId, byPost: true }
    ])
    expect(stranger.changes(from[2])).deep.equals([])
  })

  it('sends two plays inside the window as one changed (Coalesce)', async function () {
    const event = await scopeSocket(103)
    expect(
      await event.ask({ type: 'subscribe', scope: 'event', gameId })
    ).deep.include({ type: 'subscribed', scope: 'event' })
    await quiet()
    const from = event.frames.length
    const mark = notices.mark()
    await Promise.all([
      ok('POST', `/games/${gameId}/events`, livePost(4), 101),
      ok('POST', `/games/${gameId}/events`, livePost(5), 101)
    ])
    const heard = await notices.since(mark)
    expect(heard.map(payload => payload.gameId)).deep.equals([gameId, gameId])
    await quiet()
    expect(event.changes(from)).deep.equals([
      { type: 'changed', scope: 'event', gameId, byPost: true }
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

  /**
   * A post tells the screen scopes only of a change a list shows of its game,
   * as the post's (`byPost`); every viewer of the game hears each post as a
   * play frame.
   */
  describe('only shown changes', function () {
    const about = (
      atBatIndex: number,
      inning = 1,
      top = true
    ): Record<string, unknown> => ({
      atBatIndex,
      inning,
      halfInning: top ? 'top' : 'bottom',
      isTopInning: top,
      isComplete: false
    })
    const pitchesOf = (calls: readonly string[]): object[] =>
      calls.map((code, index) => ({
        type: 'pitch',
        isPitch: true,
        index,
        details: { call: { code } }
      }))
    /** The at-bat in progress, `calls` pitched, as a scorer posts it. */
    const atBat = (calls: readonly string[], at = about(0)): object => ({
      mode: 'live',
      source: { system: 'manual' },
      plays: [],
      currentPlay: {
        about: at,
        count: {
          balls: calls.filter(code => code === 'B').length,
          strikes: Math.min(2, calls.filter(code => code !== 'B').length),
          outs: 0
        },
        playEvents: pitchesOf(calls)
      }
    })
    /** A home run on at-bat 0 for the visitors, then at-bat 1 begins. */
    const homeRun = {
      mode: 'live',
      source: { system: 'manual' },
      plays: [
        {
          about: { ...about(0), isComplete: true, isScoringPlay: true },
          playEvents: pitchesOf(['B', 'X']),
          result: {
            type: 'atBat',
            eventType: 'home_run',
            awayScore: 1,
            homeScore: 0,
            rbi: 1
          }
        }
      ],
      currentPlay: {
        about: about(1),
        count: { balls: 0, strikes: 0, outs: 0 },
        playEvents: []
      }
    }

    /** A game of team A at home and the standalone team away, under way. */
    const begun = async (): Promise<string> => {
      const id = makeId('game')
      await f.h.db
        .insertInto('games')
        .values({
          id,
          home_team_id: f.teamA,
          away_team_id: f.standaloneTeam,
          season_id: f.seasonA,
          start_at: new Date(Date.now() - 600_000)
        })
        .execute()
      await ok('POST', `/games/${id}/events`, atBat(['B']), 101)
      return id
    }

    /** An event screen and a game frame on the game, home for one side and schedule for the other. */
    const watching = async (
      gameId: string
    ): Promise<{
      event: ScopeSocket
      home: ScopeSocket
      schedule: ScopeSocket
    }> => {
      const event = await scopeSocket(101)
      const home = await scopeSocket(101)
      const schedule = await scopeSocket(103)
      expect(
        await event.ask({ type: 'subscribe', scope: 'event', gameId })
      ).deep.include({ type: 'subscribed', scope: 'event' })
      expect(await event.ask({ type: 'subscribe', gameId })).deep.include({
        type: 'subscribed',
        gameId
      })
      expect(await home.ask({ type: 'subscribe', scope: 'home' })).deep.include(
        { type: 'subscribed' }
      )
      expect(
        await schedule.ask({ type: 'subscribe', scope: 'schedule' })
      ).deep.include({ type: 'subscribed' })
      await quiet()
      return { event, home, schedule }
    }

    it('tells no screen scope of a pitch that changes only the count, and the game’s viewers hear its frame', async function () {
      const gameId = await begun()
      const { event, home, schedule } = await watching(gameId)
      const from = [event, home, schedule].map(each => each.frames.length)
      const sent = await announcedDuring(async () => {
        await ok('POST', `/games/${gameId}/events`, atBat(['B', 'C']), 101)
        await ok('POST', `/games/${gameId}/events`, atBat(['B', 'C', 'F']), 101)
      })
      expect(sent).deep.equals([])
      await quiet()
      expect(
        event.frames
          .slice(from[0])
          .some(
            frame =>
              frame.type === 'change' &&
              frame.gameId === gameId &&
              frame.kind === 'playEdits'
          )
      ).equals(true)
      expect(event.changes(from[0])).deep.equals([])
      expect(home.changes(from[1])).deep.equals([])
      expect(schedule.changes(from[2])).deep.equals([])
    })

    it('tells home and schedule, as the post’s, of a run, a half, an inning and a final', async function () {
      const gameId = await begun()
      const { home, schedule } = await watching(gameId)
      const shown = async (body: object): Promise<void> => {
        const from = [home.frames.length, schedule.frames.length]
        const sent = await announcedDuring(async () => {
          await ok('POST', `/games/${gameId}/events`, body, 101)
        })
        expect(sent).lengthOf(1)
        expect(sent[0]).deep.include({ gameId, byPost: true })
        await quiet()
        for (const [index, each] of [home, schedule].entries())
          expect(each.changes(from[index])).deep.include({
            type: 'changed',
            scope: index === 0 ? 'home' : 'schedule',
            gameId,
            byPost: true
          })
      }
      // A run scored.
      await shown(homeRun)
      // The half turns, then the inning.
      await shown(atBat([], about(1, 1, false)))
      await shown(atBat([], about(1, 2, true)))
      // The game ends: its teams' records and season are told, as before.
      const final = {
        mode: 'live',
        source: { system: 'manual' },
        plays: [
          {
            about: { ...about(1, 2), isComplete: true },
            result: { eventType: 'final_score', awayScore: 1, homeScore: 0 }
          }
        ]
      }
      const sent = await announcedDuring(async () => {
        await ok('POST', `/games/${gameId}/events`, final, 101)
      })
      expect(sent).lengthOf(1)
      expect(sent[0]).deep.members([
        { gameId, byPost: true },
        { teamId: f.teamA },
        { teamId: f.standaloneTeam },
        { seasonId: f.seasonA }
      ])
    })
  })
})
