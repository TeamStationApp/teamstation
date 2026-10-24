import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'
import WebSocket from 'ws'

import type { GameSocketReply } from '../../common/gameSocket'
import { userIdOfGumbo } from '../../common/userId'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { changeNodeAccount } from '../admin/nodeAdministration'
import type { Database } from '../db/database'
import { attachGameSocket, type GameSocketHandle } from '../socket/gameSocket'

describe('private socket access follows approved game revisions', function () {
  this.timeout(60000)
  let f: GroupFixture
  let server: Server
  let socket: GameSocketHandle
  let socketUrl: string
  let databaseUrl: string
  const clients: WebSocket[] = []
  beforeEach(async () => {
    f = await groupFixture()
    const result = await sql<{
      name: string
    }>`select current_database() as name`.execute(f.h.db)
    const url = testDatabaseUrl.replace(/\/[^/]*$/, '/' + result.rows[0].name)
    databaseUrl = url
    server = createServer()
    socket = attachGameSocket(server, f.h.db, url, {
      pingMs: 0,
      recheckMs: 60000,
      log: () => {},
      fanout: { coalesceMs: 10, log: () => {} }
    })
    await socket.fanout.listening
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    socketUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket`
  })
  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate()
    await socket?.close()
    if (server?.listening)
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          error == null ? resolve() : reject(error)
        })
      })
    await f?.h.close()
  })
  async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 15000
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error('Expected socket observation did not arrive')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  async function subscribe(
    user: number,
    id: string
  ): Promise<GameSocketReply[]> {
    const client = new WebSocket(socketUrl, {
      headers: { authorization: `Bearer ${f.h.tokens.get(user)!}` }
    })
    clients.push(client)
    const frames: GameSocketReply[] = []
    client.on('message', data => {
      frames.push(
        JSON.parse(
          (Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data)
          ).toString()
        ) as GameSocketReply
      )
    })
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    client.send(
      JSON.stringify({ type: 'subscribe', gameId: id, id: `subscribe-${user}` })
    )
    await until(() => frames.some(frame => frame.type === 'subscribed')).catch(
      (error: unknown) => {
        throw new Error(`${String(error)}: ${JSON.stringify(frames)}`)
      }
    )
    return frames
  }
  it('completes ten concurrent private deliveries on a ten-connection pool without acquiring nested connections', async () => {
    await socket.close()
    const deliveryDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString: databaseUrl,
          max: 10,
          connectionTimeoutMillis: 1500
        })
      })
    })
    socket = attachGameSocket(server, deliveryDb, databaseUrl, {
      pingMs: 60000,
      log: () => {},
      fanout: { log: () => {} }
    })
    await socket.fanout.listening
    try {
      const ids = Array.from({ length: 10 }, (_, i) => `gam_demo_delivery_${i}`)
      await f.h.db
        .insertInto('games')
        .values(
          ids.map(id => ({
            id,
            home_team_id: f.teamA,
            away_team_id: f.teamB,
            season_id: f.seasonB,
            start_at: new Date(),
            status: 'scheduled'
          }))
        )
        .execute()
      const frames: GameSocketReply[][] = []
      for (const id of ids) frames.push(await subscribe(102, id))
      await Promise.all(
        ids.map(async game => {
          await socket.fanout.deliver(JSON.stringify({ game, kind: 'lineups' }))
        })
      )
      await until(() =>
        frames.every(messages =>
          messages.some(
            frame => frame.type === 'change' && frame.kind === 'lineups'
          )
        )
      )
      expect(
        (await f.h.request('GET', `/games/${ids[0]}`, undefined, 102)).status
      ).equals(200)
    } finally {
      await socket.close()
      await deliveryDb.destroy()
    }
  })
  for (const move of ['season', 'opponent'] as const)
    it(
      move === 'season'
        ? 'refuses a hosting-season move without changing existing private access'
        : 'allows published pending metadata but denies old opponent viewers private frames after approval',
      async () => {
        if (move === 'season')
          await f.h.db
            .insertInto('season_members')
            .values({
              id: 'membership_socket_old_season',
              season_id: f.seasonA,
              user_id: userIdOfGumbo(106)
            })
            .execute()
        else
          await f.h.db
            .insertInto('memberships')
            .values({
              id: 'membership_socket_old_team',
              team_id: f.teamA,
              user_id: userIdOfGumbo(106),
              role: 'member'
            })
            .execute()
        const game = {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-01T19:00:00Z',
          status: 'scheduled',
          venue: 'Demo Socket Park'
        }
        const proposed = await f.h.request(
          'POST',
          '/game-requests',
          {
            sender: { kind: 'season', id: f.seasonA },
            game,
            idempotencyKey: `socket-original-${move}`
          },
          101
        )
        expect(proposed.status).equals(201)
        const original = (await proposed.json()) as { id: string }
        const published = (await (
          await f.h.request(
            'POST',
            `/game-requests/${original.id}/accept`,
            {},
            102
          )
        ).json()) as { status: string; gameId: string }
        expect(published.status).equals('accepted')
        const oldViewer = await subscribe(106, published.gameId)
        const currentViewer = await subscribe(102, published.gameId)
        const from = oldViewer.length
        const scheduling = (await (
          await f.h.request(
            'GET',
            `/games/${published.gameId}/scheduling`,
            undefined,
            101
          )
        ).json()) as { version: string }
        const changed = {
          ...game,
          ...(move === 'season'
            ? { seasonId: f.playoffs }
            : { homeTeamId: f.standaloneTeam })
        }
        const sent = await f.h.request(
          'POST',
          '/game-requests',
          {
            sender: {
              kind: 'season',
              id: move === 'season' ? f.playoffs : f.seasonA
            },
            game: changed,
            gameId: published.gameId,
            expected: scheduling.version,
            idempotencyKey: `socket-revision-${move}`
          },
          101
        )
        if (move === 'season') {
          expect(sent.status).equals(400)
          expect(
            await f.h.db
              .selectFrom('games')
              .select('season_id')
              .where('id', '=', published.gameId)
              .executeTakeFirstOrThrow()
          ).property('season_id', f.seasonA)
          expect(
            await f.h.db.selectFrom('group_requests').select('id').execute()
          ).length(1)
          expect(
            (
              await f.h.request(
                'GET',
                `/games/${published.gameId}`,
                undefined,
                106
              )
            ).status
          ).equals(200)
          const controlFrom = currentViewer.length
          await socket.fanout.deliver(
            JSON.stringify({ game: published.gameId, kind: 'lineups' })
          )
          await socket.fanout.deliver(
            JSON.stringify({ game: published.gameId, kind: 'plays' })
          )
          await until(() =>
            ['lineups', 'plays'].every(kind =>
              [oldViewer.slice(from), currentViewer.slice(controlFrom)].every(
                frames =>
                  frames.some(
                    frame => frame.type === 'change' && frame.kind === kind
                  )
              )
            )
          )
          return
        }
        expect(sent.status).equals(201)
        const revision = (await sent.json()) as { id: string }
        // Pending changes retain the published matchup and its viewers. The
        // game nudge carries only the published status, scores and teams,
        // never proposed terms.
        expect(
          (
            await f.h.request(
              'GET',
              `/games/${published.gameId}`,
              undefined,
              106
            )
          ).status
        ).equals(200)
        await socket.fanout.deliver(
          JSON.stringify({ game: published.gameId, kind: 'game' })
        )
        await until(() =>
          oldViewer
            .slice(from)
            .some(frame => frame.type === 'change' && frame.kind === 'game')
        )
        for (const frame of oldViewer.slice(from))
          if (frame.type === 'change') {
            expect(frame.kind).equals('game')
            expect(frame.data).deep.equals({
              status: 'scheduled',
              awayScore: null,
              homeScore: null,
              homeTeamId: f.teamA,
              awayTeamId: f.teamB
            })
          }
        const privateFrom = oldViewer.length
        for (const user of [102, 103])
          expect(
            (
              await f.h.request(
                'POST',
                `/game-requests/${revision.id}/accept`,
                {},
                user
              )
            ).status
          ).equals(200)
        expect(
          (
            await f.h.db
              .selectFrom('group_requests')
              .select('status')
              .where('id', '=', revision.id)
              .executeTakeFirstOrThrow()
          ).status
        ).equals('accepted')
        // The old opponent reads the game now only in the non-member view.
        const outside = await f.h.request(
          'GET',
          `/games/${published.gameId}`,
          undefined,
          106
        )
        expect(outside.status).equals(200)
        expect(
          ((await outside.json()) as { nonMemberView: boolean }).nonMemberView
        ).equals(true)
        const controlFrom = currentViewer.length
        await socket.fanout.deliver(
          JSON.stringify({ game: published.gameId, kind: 'lineups' })
        )
        await socket.fanout.deliver(
          JSON.stringify({ game: published.gameId, kind: 'plays' })
        )
        await until(() =>
          ['lineups', 'plays'].every(kind =>
            currentViewer
              .slice(controlFrom)
              .some(frame => frame.type === 'change' && frame.kind === kind)
          )
        )
        expect(
          oldViewer
            .slice(privateFrom)
            .filter(frame => frame.type === 'change' && frame.kind !== 'game')
        ).length(0)
      }
    )
  it('requires fresh credentials after suspension and reactivation instead of resuming an old socket', async () => {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'membership_socket_reactivate',
        team_id: f.teamA,
        user_id: userIdOfGumbo(106),
        role: 'member'
      })
      .execute()
    const response = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-01T19:00:00Z',
          status: 'scheduled'
        },
        idempotencyKey: 'socket-reactivation'
      },
      101
    )
    expect(response.status).equals(201)
    const { id } = (await response.json()) as { id: string }
    const accepted = (await (
      await f.h.request('POST', `/game-requests/${id}/accept`, {}, 102)
    ).json()) as { gameId: string }
    const revoked = await subscribe(106, accepted.gameId)
    const current = await subscribe(102, accepted.gameId)
    const from = revoked.length
    const currentFrom = current.length
    let closed = false
    clients[0].once('close', () => {
      closed = true
    })
    await changeNodeAccount(f.h.db, actor(105), userIdOfGumbo(106), {
      suspended: true
    })
    await changeNodeAccount(f.h.db, actor(105), userIdOfGumbo(106), {
      suspended: false
    })
    expect(
      (
        await f.h.request(
          'GET',
          `/games/${accepted.gameId}/box-score`,
          undefined,
          106
        )
      ).status
    ).equals(401)
    await socket.fanout.deliver(
      JSON.stringify({ game: accepted.gameId, kind: 'plays' })
    )
    await until(
      () =>
        closed &&
        current
          .slice(currentFrom)
          .some(frame => frame.type === 'change' && frame.kind === 'plays')
    )
    expect(revoked.slice(from).filter(frame => frame.type === 'change')).length(
      0
    )
  })
})
