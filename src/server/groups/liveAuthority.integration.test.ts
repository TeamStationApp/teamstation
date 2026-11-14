import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { changeNodeAccount } from '../admin/nodeAdministration'
import { actorForToken, createSession } from '../auth/sessions'
import { setScopeRoles } from '../invites/people'
import {
  beganPublishing,
  type LiveControllerOptions,
  resolveKey,
  sync
} from '../live/controller'
import {
  attachSessionForTest,
  configureIngest,
  liveKeys,
  resetForTest,
  setLive
} from '../live/splitter'
import { createLiveStream } from '../live/streamKeys'
import { applyParents, previewParents } from './relationships'

describe('live publishing credentials and current filming rights', function () {
  this.timeout(60000)
  let f: GroupFixture
  let root: string
  let options: LiveControllerOptions
  const gameId = 'gam_demo_live_authority'
  beforeEach(async () => {
    f = await groupFixture()
    root = await mkdtemp(join(tmpdir(), 'tsLiveAuthority-'))
    options = {
      db: f.h.db,
      mediaRoot: root,
      workDir: join(root, 'work'),
      ffmpegPath: '/not-used',
      sessionSecret: 's'.repeat(32),
      live: {
        enabled: true,
        bindHost: '127.0.0.1',
        port: 0,
        app: 'live',
        segmentSeconds: 4,
        freeDiskFloorGb: 1
      },
      freeBytes: async () => 1_000_000_000_000
    }
    configureIngest({
      ...options.live,
      ffmpegPath: options.ffmpegPath,
      log: () => {},
      onEvent: () => {}
    })
    await f.h.db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonB,
        start_at: new Date()
      })
      .execute()
  })
  afterEach(async () => {
    resetForTest()
    await rm(root, { recursive: true, force: true })
    await f?.h.close()
  })
  async function issue(
    userId: number,
    slot = 1
  ): Promise<Awaited<ReturnType<typeof createLiveStream>>> {
    return await createLiveStream(f.h.db, {
      gameId,
      teamId: f.teamA,
      userId: userIdOfGumbo(userId),
      slot,
      startAt: new Date(),
      videoTitle: 'Demo game',
      live: options.live,
      sessionSecret: options.sessionSecret
    })
  }
  async function connect(key: string): Promise<() => boolean> {
    // Exercise the cold door first, then an established ingest session that
    // must be disconnected by the same periodic sync production uses.
    const spec = await resolveKey(key, options)
    expect(typeof spec).equals('object')
    if (spec == null || typeof spec === 'string')
      throw new Error('Expected authorized stream')
    setLive(key, spec)
    let closed = false
    attachSessionForTest(key, {
      id: 'demo-publisher',
      close: () => {
        closed = true
      }
    })
    expect(liveKeys()).includes(key)
    return () => closed
  }
  it('suspends and disconnects the operator, keeps the old key revoked after reactivation, and requires a new credential', async () => {
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(106),
      { admin: false, flags: ['videographer'] },
      userIdOfGumbo(101)
    )
    const stream = await issue(106)
    const closed = await connect(stream.key)
    await beganPublishing(options, stream.id)
    expect(
      (
        await f.h.db
          .selectFrom('live_streams')
          .select('state')
          .where('id', '=', stream.id)
          .executeTakeFirstOrThrow()
      ).state
    ).equals('publishing')
    await changeNodeAccount(
      f.h.db,
      { ...actor(105), isAdmin: true },
      userIdOfGumbo(106),
      {
        suspended: true
      }
    )
    const revoked = await f.h.db
      .selectFrom('live_streams')
      .select('state')
      .where('id', '=', stream.id)
      .executeTakeFirstOrThrow()
    expect(revoked.state).equals('revoked')
    await beganPublishing(options, stream.id)
    expect(
      (
        await f.h.db
          .selectFrom('live_streams')
          .select('state')
          .where('id', '=', stream.id)
          .executeTakeFirstOrThrow()
      ).state
    ).equals('revoked')
    expect(await actorForToken(f.h.db, f.h.tokens.get(106)!)).equals(undefined)
    await sync(options)
    expect(closed()).equals(true)
    expect(liveKeys()).not.includes(stream.key)
    expect(typeof (await resolveKey(stream.key, options))).equals('string')
    await changeNodeAccount(
      f.h.db,
      { ...actor(105), isAdmin: true },
      userIdOfGumbo(106),
      {
        suspended: false
      }
    )
    await beganPublishing(options, stream.id)
    expect(typeof (await resolveKey(stream.key, options))).equals('string')
    expect(await actorForToken(f.h.db, f.h.tokens.get(106)!)).equals(undefined)
    expect(
      await actorForToken(
        f.h.db,
        (await createSession(f.h.db, userIdOfGumbo(106), 'fresh-fixture')).token
      )
    ).property('userId', userIdOfGumbo(106))
    expect(typeof (await resolveKey((await issue(106)).key, options))).equals(
      'object'
    )
  })
  for (const mode of ['cold', 'sync'] as const)
    for (const loss of ['direct', 'parent', 'matchup'] as const) {
      it(`revokes the key and disconnects after ${loss} authority is lost (${mode})`, async () => {
        await setScopeRoles(
          f.h.db,
          loss === 'parent' ? 'season' : 'team',
          loss === 'parent' ? f.seasonA : f.teamA,
          userIdOfGumbo(106),
          { admin: false, flags: ['videographer'] },
          userIdOfGumbo(101)
        )
        const stream = await issue(106)
        const closed = await connect(stream.key)
        if (loss === 'direct')
          await setScopeRoles(
            f.h.db,
            'team',
            f.teamA,
            userIdOfGumbo(106),
            { admin: false, flags: [] },
            userIdOfGumbo(101)
          )
        if (loss === 'parent') {
          const actions = [
            {
              operation: 'detach',
              parent: { kind: 'season', id: f.seasonA },
              child: { kind: 'team', id: f.teamA }
            }
          ] as const
          const preview = await previewParents(f.h.db, [...actions])
          await applyParents(f.h.db, [actor(101)], preview)
        }
        if (loss === 'matchup')
          await f.h.db
            .updateTable('games')
            .set({ home_team_id: f.standaloneTeam })
            .where('id', '=', gameId)
            .execute()
        if (mode === 'cold')
          expect(typeof (await resolveKey(stream.key, options))).equals(
            'string'
          )
        else await sync(options)
        expect(closed()).equals(true)
        await sync(options)
        expect(liveKeys()).not.includes(stream.key)
        expect(
          (
            await f.h.db
              .selectFrom('live_streams')
              .select('state')
              .where('id', '=', stream.id)
              .executeTakeFirstOrThrow()
          ).state
        ).equals('revoked')
        const witness = await issue(102)
        // This key is bound to the removed side, so even a node-equivalent host
        // cannot publish an unrelated team; the real remaining away side can.
        await f.h.db
          .updateTable('live_streams')
          .set({ team_id: f.teamB })
          .where('id', '=', witness.id)
          .execute()
        expect(typeof (await resolveKey(witness.key, options))).equals('object')
      })
    }
})
