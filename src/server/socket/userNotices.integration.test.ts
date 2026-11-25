import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'
import WebSocket from 'ws'

import {
  GAME_SOCKET_PROTOCOL,
  type GameSocketReply
} from '../../common/gameSocket'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import { FEED_APPLICATION_NAME } from '../changeFeed/postgresFeed'
import { type Database, makeDatabase } from '../db/database'
import { attachGameSocket, type GameSocketHandle } from './gameSocket'
import { announceNotedScopes } from './syncRevision'
import { publishUserNotice } from './userNotices'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

interface Listener {
  ws: WebSocket
  frames: GameSocketReply[]
  send: (frame: unknown) => void
  next: (
    match: (frame: GameSocketReply) => boolean,
    from?: number
  ) => Promise<GameSocketReply>
}

const SCORER = 'tok_notice_scorer_0000000000000000'
const MEMBER = 'tok_notice_member_0000000000000000'
const OUTSIDER = 'tok_notice_outsider_00000000000000'

/**
 * What a person's screens hear to read again, on two workers over one
 * scratch database: the bell, the phone's offline games, a team's documents,
 * and the team and group screens.
 */
describe('refresh notices on the game socket', function () {
  this.timeout(60000)
  const scratchName = `teamstation_user_notices_${Date.now()}_${process.pid}`
  const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)
  let admin: Pool
  let db: Kysely<Database>
  const servers: Server[] = []
  const handles: GameSocketHandle[] = []
  const urls: string[] = []
  const listeners: Listener[] = []

  const taken = new Set<number>()
  const mint = (): { userId: number; legacyId: string } => {
    const minted = mintUserId(id => taken.has(id))
    taken.add(minted.userId)
    return minted
  }
  const scorer = mint()
  const member = mint()
  const outsider = mint()
  const home = makeId('team')
  const away = makeId('team')
  const elsewhere = makeId('team')
  const league = makeId('league')
  const season = makeId('season')
  const game = makeId('game')
  const idOf = (user: { userId: number }): string => userIdOfGumbo(user.userId)

  async function listen(token: string, worker = 1): Promise<Listener> {
    const ws = new WebSocket(urls[worker], {
      headers: { authorization: `Bearer ${token}` }
    })
    const frames: GameSocketReply[] = []
    ws.on('message', data => {
      frames.push(
        JSON.parse((data as Buffer).toString('utf8')) as GameSocketReply
      )
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
    })
    const listener: Listener = {
      ws,
      frames,
      send: frame => {
        ws.send(JSON.stringify(frame))
      },
      next: async (match, from = 0) => {
        const deadline = Date.now() + 4000
        for (;;) {
          const found = frames.slice(from).find(match)
          if (found != null) return found
          if (Date.now() > deadline)
            throw new Error(`No such frame in ${JSON.stringify(frames)}`)
          await wait(10)
        }
      }
    }
    listeners.push(listener)
    return listener
  }
  async function ask(
    listener: Listener,
    frame: Record<string, unknown>
  ): Promise<GameSocketReply> {
    const from = listener.frames.length
    const id = makeId('event')
    listener.send({
      ...(frame.type === 'subscribe' ? { protocol: GAME_SOCKET_PROTOCOL } : {}),
      ...frame,
      id
    })
    return await listener.next(reply => 'id' in reply && reply.id === id, from)
  }
  const told = (listener: Listener, from: number, topic: string): boolean =>
    listener.frames
      .slice(from)
      .some(
        frame =>
          frame.type === 'userChanged' &&
          (frame as { topic: string }).topic === topic
      )
  /** Waits out every notice window, then says what was told. */
  const settled = async (): Promise<void> => {
    await wait(400)
  }

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const at = new Date()
    await insertFixtureUsers(
      db,
      [scorer, member, outsider].map(user => ({
        id: user.userId,
        legacyId: user.legacyId,
        display_name: `User ${user.userId}`,
        is_admin: false,
        created_at: at,
        updated_at: at
      }))
    )
    await db
      .insertInto('auth_sessions')
      .values(
        (
          [
            [scorer, SCORER],
            [member, MEMBER],
            [outsider, OUTSIDER]
          ] as const
        ).map(([user, token]) => ({
          id: `ses_${token}`,
          user_id: idOf(user),
          token_hash: hashToken(token),
          created_at: at,
          expires_at: new Date(at.getTime() + 3_600_000)
        }))
      )
      .execute()
    await db
      .insertInto('leagues')
      .values({ id: league, name: 'League' })
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: season,
        name: 'Season',
        league_id: league,
        year: 2026,
        starts_on: '2026-01-01',
        ends_on: '2026-12-31',
        created_at: new Date(),
        updated_at: new Date()
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home', kind: 'full' },
        { id: away, name: 'Away', kind: 'full' },
        { id: elsewhere, name: 'Elsewhere', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values({
        id: game,
        home_team_id: home,
        away_team_id: away,
        season_id: season,
        start_at: new Date(at.getTime() + 3_600_000)
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: idOf(member),
        team_id: home,
        role: 'member'
      })
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: randomUUID(),
        user_id: idOf(scorer),
        scope_type: 'team',
        scope_id: home,
        role: 'scorekeeper',
        granted_by: idOf(member)
      })
      .execute()
    for (let worker = 0; worker < 2; worker++) {
      const server = createServer()
      const handle = attachGameSocket(server, db, scratchUrl, {
        pingMs: 60_000,
        stopSignals: null,
        resyncSpreadMs: 0,
        screenNoticeSpreadMs: 0,
        fanout: { coalesceMs: 20, log: () => undefined },
        screenScopes: { coalesceMs: 40, log: () => undefined },
        log: () => undefined
      })
      await handle.fanout.listening
      await handle.screenScopes.listening
      await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', resolve)
      })
      servers.push(server)
      handles.push(handle)
      urls.push(
        `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket`
      )
    }
    // Every worker's LISTEN is in place before anything is written.
    await wait(300)
  })

  after(async function () {
    for (const listener of listeners) listener.ws.terminate()
    for (const handle of handles) await handle.close()
    for (const server of servers)
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
        server.closeAllConnections()
      })
    await db?.destroy()
    await admin?.query(`drop database if exists ${scratchName} with (force)`)
    await admin?.end()
  })

  it('holds a topic for its own person, and tells it what another worker commits for them, never a rollback', async () => {
    const bell = await listen(MEMBER)
    const other = await listen(OUTSIDER)
    expect(await ask(bell, { type: 'subscribe', topic: 'badge' })).deep.include(
      {
        type: 'subscribed',
        topic: 'badge'
      }
    )
    await ask(other, { type: 'subscribe', topic: 'badge' })
    const from = bell.frames.length
    const elsewhereFrom = other.frames.length
    // Written through the database the other worker shares.
    await db
      .transaction()
      .execute(async trx => {
        await trx
          .insertInto('notification_events')
          .values({
            id: randomUUID(),
            source_type: 'grant',
            source_id: randomUUID(),
            revision: 1,
            actor_id: null,
            metadata: JSON.stringify({}),
            recorded_recipients: [idOf(member)],
            created_at: new Date()
          })
          .execute()
        throw new Error('rolled back')
      })
      .catch(() => undefined)
    await settled()
    expect(told(bell, from, 'badge'), 'a rollback says nothing').equals(false)
    await db
      .insertInto('notification_events')
      .values({
        id: randomUUID(),
        source_type: 'grant',
        source_id: randomUUID(),
        revision: 1,
        actor_id: null,
        metadata: JSON.stringify({}),
        recorded_recipients: [idOf(member)],
        created_at: new Date()
      })
      .execute()
    await bell.next(
      frame =>
        frame.type === 'userChanged' &&
        (frame as { topic: string }).topic === 'badge',
      from
    )
    await settled()
    expect(told(other, elsewhereFrom, 'badge')).equals(false)
    expect(
      bell.frames.slice(from).filter(frame => frame.type === 'userChanged'),
      'once in its window'
    ).length(1)
  })

  it('tells a request’s side’s staff, never a member who cannot answer it, and nobody else', async () => {
    const seeing = await listen(MEMBER, 0)
    const outside = await listen(OUTSIDER, 1)
    await ask(seeing, { type: 'subscribe', topic: 'badge' })
    await ask(outside, { type: 'subscribe', topic: 'badge' })
    const sendRequest = async (): Promise<void> => {
      const request = randomUUID()
      await db.transaction().execute(async trx => {
        await trx
          .insertInto('group_requests')
          .values({
            id: request,
            kind: 'participation',
            sender_id: idOf(scorer),
            sender_scope_type: 'team',
            sender_scope_id: away,
            status: 'pending',
            terms: JSON.stringify({}),
            sent_at: new Date(),
            expires_at: new Date(Date.now() + 86_400_000)
          })
          .execute()
        await trx
          .insertInto('group_request_sides')
          .values({
            request_id: request,
            scope_type: 'team',
            scope_id: home,
            approved_by: null,
            approved_at: null
          })
          .execute()
      })
    }
    let from = seeing.frames.length
    const outsideFrom = outside.frames.length
    await sendRequest()
    await settled()
    expect(told(seeing, from, 'badge'), 'a plain member of the team').equals(
      false
    )
    expect(told(outside, outsideFrom, 'badge')).equals(false)
    // Their team's coach, they hear the next one.
    const coach = randomUUID()
    await db
      .insertInto('scope_roles')
      .values({
        id: coach,
        user_id: idOf(member),
        scope_type: 'team',
        scope_id: home,
        role: 'coach',
        granted_by: idOf(scorer)
      })
      .execute()
    await seeing.next(frame => frame.type === 'userChanged', from)
    await settled()
    from = seeing.frames.length
    await sendRequest()
    await seeing.next(frame => frame.type === 'userChanged', from)
    await settled()
    expect(told(outside, outsideFrom, 'badge')).equals(false)
    await db.deleteFrom('scope_roles').where('id', '=', coach).execute()
    await settled()
  })

  it('tells the owner of a verified address a request names, and a player’s guardian', async () => {
    const outside = await listen(OUTSIDER, 1)
    await ask(outside, { type: 'subscribe', topic: 'badge' })
    const address = `${randomUUID()}@example.com`
    await db
      .insertInto('user_emails')
      .values({
        id: randomUUID(),
        user_id: idOf(outsider),
        email: address,
        verified_at: new Date(),
        created_at: new Date()
      })
      .execute()
    await settled()
    const request = async (
      kind: 'participation' | 'guardian',
      terms: object,
      side: [string, string]
    ): Promise<void> => {
      const id = randomUUID()
      await db.transaction().execute(async trx => {
        await trx
          .insertInto('group_requests')
          .values({
            id,
            kind,
            sender_id: idOf(scorer),
            sender_scope_type: 'team',
            sender_scope_id: away,
            status: 'pending',
            terms: JSON.stringify(terms),
            sent_at: new Date(),
            expires_at: new Date(Date.now() + 86_400_000)
          })
          .execute()
        await trx
          .insertInto('group_request_sides')
          .values({
            request_id: id,
            scope_type: side[0] as 'user',
            scope_id: side[1],
            approved_by: null,
            approved_at: null
          })
          .execute()
      })
    }
    let from = outside.frames.length
    await request('participation', {}, [
      'user',
      `email:${address.toUpperCase()}`
    ])
    await outside.next(frame => frame.type === 'userChanged', from)
    await settled()
    // The outsider becomes the member's guardian.
    await db
      .insertInto('user_links')
      .values({
        id: randomUUID(),
        user_id: idOf(outsider),
        related_user_id: idOf(member),
        kind: 'guardian',
        created_at: new Date()
      })
      .execute()
    await settled()
    from = outside.frames.length
    await request('guardian', { playerUserId: idOf(member) }, [
      'user',
      idOf(member)
    ])
    await outside.next(frame => frame.type === 'userChanged', from)
    await db
      .deleteFrom('user_links')
      .where('user_id', '=', idOf(outsider))
      .where('related_user_id', '=', idOf(member))
      .execute()
  })

  it('tells a scorekeeper when a game of their team moves, and a role changes, but not a member who only watches', async () => {
    const phone = await listen(SCORER, 0)
    const watcher = await listen(MEMBER, 1)
    await ask(phone, { type: 'subscribe', topic: 'offlineSet' })
    await ask(watcher, { type: 'subscribe', topic: 'offlineSet' })
    let from = phone.frames.length
    const watcherFrom = watcher.frames.length
    await db
      .updateTable('games')
      .set({ start_at: new Date(Date.now() + 7_200_000) })
      .where('id', '=', game)
      .execute()
    await phone.next(frame => frame.type === 'userChanged', from)
    // A play does not move the game.
    from = phone.frames.length
    await db
      .updateTable('games')
      .set({ notes: 'a note' })
      .where('id', '=', game)
      .execute()
    await settled()
    expect(told(phone, from, 'offlineSet'), 'a note moves nothing').equals(
      false
    )
    // An imported linescore, or another keeper of its score, decides whether
    // the phone may score it.
    from = phone.frames.length
    await db
      .updateTable('games')
      .set({ linescore: JSON.stringify({ innings: [] }) })
      .where('id', '=', game)
      .execute()
    await phone.next(frame => frame.type === 'userChanged', from)
    await settled()
    from = phone.frames.length
    await db
      .updateTable('games')
      .set({ scoringOwner: 'gamechanger', linescore: null })
      .where('id', '=', game)
      .execute()
    await phone.next(frame => frame.type === 'userChanged', from)
    await settled()
    expect(told(watcher, watcherFrom, 'offlineSet')).equals(false)
    // A role given to the watcher tells them; their games are read again.
    await db
      .insertInto('scope_roles')
      .values({
        id: randomUUID(),
        user_id: idOf(member),
        scope_type: 'season',
        scope_id: season,
        role: 'scorekeeper',
        granted_by: idOf(scorer)
      })
      .execute()
    await watcher.next(frame => frame.type === 'userChanged', watcherFrom)
  })

  it('tells a scorekeeper whose season role reached a team when that team leaves the season', async () => {
    // The member keeps score for the season (an earlier case's role), so
    // for every team in it.
    const linked = makeId('team')
    await db
      .insertInto('teams')
      .values({ id: linked, name: 'Linked', kind: 'full' })
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: season, team_id: linked, joined_at: new Date() })
      .execute()
    await settled()
    const phone = await listen(MEMBER, 0)
    await ask(phone, { type: 'subscribe', topic: 'offlineSet' })
    await settled()
    const from = phone.frames.length
    await db
      .deleteFrom('season_teams')
      .where('season_id', '=', season)
      .where('team_id', '=', linked)
      .execute()
    await phone.next(frame => frame.type === 'userChanged', from)
  })

  it('arms a moment on the worker that holds the socket, from a notice published anywhere, and fires it once', async () => {
    const phone = await listen(SCORER, 1)
    await ask(phone, { type: 'subscribe', topic: 'offlineSet' })
    const from = phone.frames.length
    await publishUserNotice(
      db,
      [idOf(scorer)],
      'offlineSet',
      new Date(Date.now() + 500)
    )
    await wait(200)
    expect(told(phone, from, 'offlineSet'), 'not yet').equals(false)
    await phone.next(frame => frame.type === 'userChanged', from)
    await wait(700)
    expect(
      phone.frames.slice(from).filter(frame => frame.type === 'userChanged')
    ).length(1)
  })

  it('keeps a moment published before the socket holds its topic, and arms it on the subscribe', async () => {
    // Signing in, the read that publishes the moment can beat the socket's
    // subscribe to the server.
    // Nobody else holds the outsider's offlineSet on any worker.
    const phone = await listen(OUTSIDER, 1)
    await publishUserNotice(
      db,
      [idOf(outsider)],
      'offlineSet',
      new Date(Date.now() + 1500)
    )
    // Long enough for the worker to have heard it before the subscribe.
    await wait(700)
    await ask(phone, { type: 'subscribe', topic: 'offlineSet' })
    const from = phone.frames.length
    expect(told(phone, from, 'offlineSet'), 'not yet').equals(false)
    await phone.next(frame => frame.type === 'userChanged', from)
    await wait(700)
    expect(
      phone.frames.slice(from).filter(frame => frame.type === 'userChanged')
    ).length(1)
  })

  it('sends a game’s roster and default lineup changes to protocol-6 subscribers of the team’s games only', async () => {
    const viewer = await listen(MEMBER, 0)
    const older = await listen(SCORER, 1)
    await ask(viewer, { type: 'subscribe', gameId: game })
    await ask(older, { type: 'subscribe', gameId: game, protocol: 5 })
    const from = viewer.frames.length
    const olderFrom = older.frames.length
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: idOf(outsider),
        team_id: away,
        role: 'member'
      })
      .execute()
    const roster = await viewer.next(
      frame =>
        frame.type === 'change' &&
        (frame as { kind: string }).kind === 'roster',
      from
    )
    expect((roster as { data: unknown }).data).deep.equals({ teamId: away })
    await db
      .updateTable('teams')
      .set({ default_lineup: JSON.stringify({ lineup: [] }) })
      .where('id', '=', home)
      .execute()
    await viewer.next(
      frame =>
        frame.type === 'change' &&
        (frame as { kind: string }).kind === 'defaultLineup',
      from
    )
    await settled()
    expect(
      older.frames
        .slice(olderFrom)
        .some(
          frame =>
            frame.type === 'change' &&
            ['roster', 'defaultLineup'].includes(
              (frame as { kind: string }).kind
            )
        ),
      'an older app hears neither'
    ).equals(false)
  })

  it('holds a team screen, a non-member’s included, and a season or league screen, and tells them their team’s, game’s and season’s notices', async () => {
    const teamScreen = await listen(MEMBER, 0)
    expect(
      await ask(teamScreen, { type: 'subscribe', scope: 'team', teamId: home })
    ).deep.include({ type: 'subscribed', scope: 'team' })
    expect(
      await ask(teamScreen, {
        type: 'subscribe',
        scope: 'team',
        teamId: elsewhere
      }),
      'a team they read in the non-member view'
    ).deep.include({ type: 'subscribed', scope: 'team' })
    expect(
      await ask(teamScreen, {
        type: 'subscribe',
        scope: 'team',
        teamId: makeId('team')
      }),
      'no such team'
    ).deep.include({ type: 'error', code: 'notFound' })
    await ask(teamScreen, { type: 'subscribe', scope: 'team', teamId: home })
    let from = teamScreen.frames.length
    // A post of plays alone is the game's screens' own, not the team page's.
    await db.transaction().execute(async trx => {
      await announceNotedScopes(trx, { gameId: game, byPost: true })
    })
    await settled()
    expect(
      teamScreen.frames.slice(from).some(frame => frame.type === 'changed'),
      'a play'
    ).equals(false)
    await db.transaction().execute(async trx => {
      await announceNotedScopes(trx, { gameId: game })
    })
    expect(
      await teamScreen.next(frame => frame.type === 'changed', from)
    ).deep.include({ scope: 'team', teamId: home, gameId: game })
    // The member sees the season through the role an earlier case gave.
    const leagueScreen = await listen(MEMBER, 1)
    expect(
      await ask(leagueScreen, {
        type: 'subscribe',
        scope: 'group',
        kind: 'league',
        groupId: league
      })
    ).deep.include({ type: 'subscribed', scope: 'group' })
    from = leagueScreen.frames.length
    await db.transaction().execute(async trx => {
      await announceNotedScopes(trx, { seasonId: season })
    })
    expect(
      await leagueScreen.next(frame => frame.type === 'changed', from)
    ).deep.include({ scope: 'group', groupId: league })
  })

  it('asks every socket holding topics to read each once after its worker lost the feed', async () => {
    const bell = await listen(MEMBER, 0)
    await ask(bell, { type: 'subscribe', topic: 'badge' })
    const plain = await listen(OUTSIDER, 0)
    const from = bell.frames.length
    const plainFrom = plain.frames.length
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = $1 and application_name = $2`,
      [scratchName, FEED_APPLICATION_NAME]
    )
    expect(
      await bell.next(frame => frame.type === 'userResync', from)
    ).deep.equals({ type: 'userResync', topics: ['badge'] })
    expect(
      plain.frames.slice(plainFrom).some(frame => frame.type === 'userResync')
    ).equals(false)
  })
  it('follows a public league screen for anyone, tells a league side only to its admins, and lets a topic go', async () => {
    const outside = await listen(OUTSIDER, 0)
    expect(
      await ask(outside, {
        type: 'subscribe',
        scope: 'group',
        kind: 'league',
        groupId: league
      }),
      'a league page is public'
    ).deep.include({ type: 'subscribed', scope: 'group' })
    expect(
      await ask(outside, {
        type: 'subscribe',
        scope: 'group',
        kind: 'league',
        groupId: makeId('league')
      }),
      'no such league'
    ).deep.include({ type: 'error', code: 'notFound' })
    expect(
      await ask(outside, {
        type: 'subscribe',
        scope: 'group',
        kind: 'season',
        groupId: season
      }),
      'a season page is public too'
    ).deep.include({ type: 'subscribed', scope: 'group' })
    expect(
      await ask(outside, {
        type: 'subscribe',
        scope: 'group',
        kind: 'season',
        groupId: makeId('season')
      }),
      'no such season'
    ).deep.include({ type: 'error', code: 'notFound' })
    await ask(outside, { type: 'subscribe', topic: 'badge' })
    // The member sees the league's season through an earlier case's role,
    // and may answer nothing for the league.
    const seeing = await listen(MEMBER, 1)
    await ask(seeing, { type: 'subscribe', topic: 'badge' })
    const sendRequest = async (): Promise<void> => {
      const request = randomUUID()
      await db.transaction().execute(async trx => {
        await trx
          .insertInto('group_requests')
          .values({
            id: request,
            kind: 'participation',
            sender_id: idOf(scorer),
            sender_scope_type: 'team',
            sender_scope_id: away,
            status: 'pending',
            terms: JSON.stringify({}),
            sent_at: new Date(),
            expires_at: new Date(Date.now() + 86_400_000)
          })
          .execute()
        await trx
          .insertInto('group_request_sides')
          .values({
            request_id: request,
            scope_type: 'league',
            scope_id: league,
            approved_by: null,
            approved_at: null
          })
          .execute()
      })
    }
    let from = seeing.frames.length
    const outsideFrom = outside.frames.length
    await sendRequest()
    await settled()
    expect(told(seeing, from, 'badge'), 'a member who cannot answer').equals(
      false
    )
    expect(told(outside, outsideFrom, 'badge')).equals(false)
    // Made the league's admin, they hear the next one.
    await db
      .insertInto('scope_roles')
      .values({
        id: randomUUID(),
        user_id: idOf(member),
        scope_type: 'league',
        scope_id: league,
        role: 'admin',
        granted_by: idOf(scorer)
      })
      .execute()
    await seeing.next(frame => frame.type === 'userChanged', from)
    await settled()
    from = seeing.frames.length
    await sendRequest()
    await seeing.next(frame => frame.type === 'userChanged', from)
    // Let go, the topic says nothing more.
    expect(
      await ask(seeing, { type: 'unsubscribe', topic: 'badge' })
    ).deep.include({ type: 'unsubscribed', topic: 'badge' })
    const after = seeing.frames.length
    await publishUserNotice(db, [idOf(member)], 'badge')
    await settled()
    expect(told(seeing, after, 'badge')).equals(false)
  })
})
