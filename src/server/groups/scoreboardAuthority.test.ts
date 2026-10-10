import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import WebSocket from 'ws'

import { NO_OVERRIDES, SCOREBOARD_CLOSE } from '../../common/scoreboard'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import {
  connectedClient,
  dropPrefix,
  testPrefix
} from '../../test/scoreboardKit'
import { changeNodeAccount } from '../admin/nodeAdministration'
import { actorForToken, createSession } from '../auth/sessions'
import { setScopeRoles } from '../invites/people'
import { attachScoreboard } from '../scoreboard/attachScoreboard'
import { makeScoreboardHub } from '../scoreboard/scoreboardHub'
import {
  makeScoreboardStore,
  type ScoreboardStore
} from '../scoreboard/scoreboardStore'
import { applyParents, previewParents } from './relationships'

describe('live scoreboard credentials and current game authority', function () {
  this.timeout(60000)
  let f: GroupFixture
  let server: Server
  let store: ScoreboardStore
  let closeHub: () => Promise<void>
  let origin: string
  let prefix: string
  const clients: WebSocket[] = []
  beforeEach(async () => {
    f = await groupFixture()
    prefix = testPrefix()
    store = makeScoreboardStore({ client: await connectedClient(), prefix })
    const hub = makeScoreboardHub({
      db: f.h.db,
      store,
      subscriber: await connectedClient(),
      log: () => {},
      checkMs: 60000,
      pingMs: 60000
    })
    server = createServer()
    closeHub = attachScoreboard(server, hub)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/scoreboard`
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_demo_scoreboard_authority',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonB,
        start_at: new Date(),
        status: 'scheduled'
      })
      .execute()
  })
  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate()
    await closeHub?.()
    if (server?.listening)
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    if (prefix != null) await dropPrefix(prefix)
    await f?.h.close()
  })
  async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error('Expected scoreboard observation did not arrive')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  async function connect(
    kind: 'socket' | 'publish' | 'dashboard',
    token?: string
  ): Promise<{
    socket: WebSocket
    frames: Array<{ balls?: number }>
    closed: () => number | undefined
  }> {
    const socket = new WebSocket(
      `${origin}/gam_demo_scoreboard_authority/${kind}`,
      { headers: token == null ? {} : { authorization: `Bearer ${token}` } }
    )
    clients.push(socket)
    const frames: Array<{ balls?: number }> = []
    let code: number | undefined
    socket.on('message', data =>
      frames.push(
        JSON.parse(
          (Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data)
          ).toString()
        ) as { balls?: number }
      )
    )
    socket.on('close', value => {
      code = value
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return { socket, frames, closed: () => code }
  }
  function update(
    socket: WebSocket,
    kind: 'publish' | 'dashboard',
    balls: number
  ): void {
    socket.send(
      JSON.stringify(
        kind === 'publish'
          ? { balls }
          : {
              type: 'overrides',
              data: {
                ...NO_OVERRIDES,
                overrideCountEnabled: true,
                overrideCount: { balls, strikes: 0, outs: 0 }
              }
            }
      )
    )
  }
  async function grantDirect(): Promise<void> {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'membership_demo_board_admin',
        user_id: 106,
        team_id: f.teamA,
        role: 'member'
      })
      .execute()
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      106,
      { admin: true, flags: [] },
      101
    )
  }
  for (const kind of ['publish', 'dashboard'] as const) {
    it(`rejects a revoked ${kind} credential after suspension/reactivation and accepts only a fresh credential`, async () => {
      await grantDirect()
      const viewer = await connect('socket')
      await until(() => viewer.frames.length > 0)
      const editor = await connect(kind, f.h.tokens.get(106))
      update(editor.socket, kind, 1)
      await until(() => viewer.frames.some(frame => frame.balls === 1))
      const before = await store.readScoreboard('gam_demo_scoreboard_authority')
      await changeNodeAccount(f.h.db, actor(105), 106, { suspended: true })
      await changeNodeAccount(f.h.db, actor(105), 106, { suspended: false })
      expect(await actorForToken(f.h.db, f.h.tokens.get(106)!)).equals(
        undefined
      )
      update(editor.socket, kind, 3)
      await until(() => editor.closed() != null)
      expect(editor.closed()).equals(SCOREBOARD_CLOSE.notSignedIn)
      expect(
        await store.readScoreboard('gam_demo_scoreboard_authority')
      ).deep.equals(before)
      const fresh = await createSession(f.h.db, 106, 'demo-scoreboard-fresh')
      const restored = await connect(kind, fresh.token)
      update(restored.socket, kind, 2)
      await until(() => viewer.frames.some(frame => frame.balls === 2))
    })
    for (const change of ['role', 'parent', 'opponent'] as const)
      it(`rechecks ${kind} authority after a ${change} change before any public scoreboard write`, async () => {
        if (change === 'parent') {
          await f.h.db
            .insertInto('season_members')
            .values({
              id: 'membership_demo_board_parent',
              user_id: 106,
              season_id: f.seasonA
            })
            .execute()
          await setScopeRoles(
            f.h.db,
            'season',
            f.seasonA,
            106,
            { admin: true, flags: [] },
            101
          )
        } else await grantDirect()
        const viewer = await connect('socket')
        await until(() => viewer.frames.length > 0)
        const editor = await connect(kind, f.h.tokens.get(106))
        update(editor.socket, kind, 1)
        await until(() => viewer.frames.some(frame => frame.balls === 1))
        const before = await store.readScoreboard(
          'gam_demo_scoreboard_authority'
        )
        if (change === 'role')
          await setScopeRoles(
            f.h.db,
            'team',
            f.teamA,
            106,
            { admin: false, flags: [] },
            101
          )
        else if (change === 'parent')
          await applyParents(
            f.h.db,
            [actor(101)],
            await previewParents(f.h.db, [
              {
                operation: 'detach',
                child: { kind: 'team', id: f.teamA },
                parent: { kind: 'season', id: f.seasonA }
              }
            ])
          )
        else
          await f.h.db
            .updateTable('games')
            .set({ home_team_id: f.standaloneTeam })
            .where('id', '=', 'gam_demo_scoreboard_authority')
            .execute()
        update(editor.socket, kind, 3)
        await until(() => editor.closed() != null)
        expect(editor.closed()).equals(SCOREBOARD_CLOSE.notAllowed)
        expect(
          await store.readScoreboard('gam_demo_scoreboard_authority')
        ).deep.equals(before)
        const witness = await connect(kind, f.h.tokens.get(102))
        update(witness.socket, kind, 2)
        await until(() => viewer.frames.some(frame => frame.balls === 2))
      })
  }
})
