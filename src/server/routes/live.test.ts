import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { angleLabels } from '../../app/player/multiCam/takes'
import { REVISION_HEADER } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { listenScreenScopes } from '../../test/screenScopeNotices'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { readSyncClock } from '../socket/syncRevision'
import { liveRoutes } from './live'
import { mediaRoutes } from './media'

/**
 * Who may have a stream key, and what happens when two people ask at once.
 *
 * The key is a publish credential: whoever holds it can put video on this
 * team's game for the length of its window. So the rule is not "hide the
 * button" — it is that the server answers a stranger **404**, which does not
 * even confirm the game has a stream. That is worth testing through the real
 * router, with the real sign-in middleware, against a real database, because
 * every one of those three is a place the rule could be lost.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_liveroutes_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const MANAGER = 'tok_manager_000000000000000000000'
const COACH = 'tok_coach_00000000000000000000000'
const PARENT = 'tok_parent_0000000000000000000000'
const FILMER = 'tok_filmer_0000000000000000000000'
const SCORER = 'tok_scorer_0000000000000000000000'

const legacyOf = new Map<number, string>()
function mintUser(): number {
  const made = mintUserId(id => legacyOf.has(id))
  legacyOf.set(made.userId, made.legacyId)
  return made.userId
}
function legacyId(userId: number): string {
  const id = legacyOf.get(userId)
  if (id == null) throw new Error(`no legacy id for ${userId}`)
  return id
}

const managerId = mintUser()
const coachId = mintUser()
const parentId = mintUser()
const filmerId = mintUser()
const scorerId = mintUser()

describe('a game’s stream key over the API', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    await seed(db)

    const app = express()
    app.use(express.json())
    app.use(withActor(db))
    app.use(withAudit(db))
    app.use(
      '/api/v1',
      liveRoutes(db, {
        live: {
          enabled: true,
          bindHost: '0.0.0.0',
          port: 1936,
          app: 'live',
          segmentSeconds: 4,
          freeDiskFloorGb: 10
        },
        sessionSecret: 'k'.repeat(32),
        host: 'live.example'
      })
    )
    // Mounted alongside, because deleting a recording is the other half of
    // removing a camera and the two are worth checking against one database.
    // No Space is configured, so nothing here reaches the network.
    app.use(
      '/api/v1',
      mediaRoutes(db, {
        ffmpegPath: '/usr/bin/ffmpeg',
        mediaRoot: '/tmp/tsLiveRoutesMedia',
        mediaSecret: 'm'.repeat(32),
        publicUrl: 'http://127.0.0.1',
        space: {
          endpoint: '',
          region: '',
          bucket: '',
          accessKeyId: '',
          secretAccessKey: '',
          pathStyle: false
        }
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    const address = server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  /** Two teams, a game, and two people: one who runs the team, one who watches. */
  async function seed(db: Kysely<Database>): Promise<void> {
    const now = new Date()
    for (const [id, name] of [
      [managerId, 'Casey Manager'],
      [coachId, 'Robin Yount'],
      [parentId, 'Parent'],
      [filmerId, 'Vic Power'],
      [scorerId, 'Kevin Kiermaier']
    ] as Array<[number, string]>) {
      await insertFixtureUsers(db, {
        id,
        legacyId: legacyId(id),
        display_name: name,
        first_name: null,
        last_name: null,
        created_at: now,
        updated_at: now
      })
    }
    for (const [id, user, token] of [
      ['ses_manager', managerId, MANAGER],
      ['ses_coach', coachId, COACH],
      ['ses_parent', parentId, PARENT],
      ['ses_filmer', filmerId, FILMER],
      ['ses_scorer', scorerId, SCORER]
    ] as Array<[string, number, string]>) {
      await db
        .insertInto('auth_sessions')
        .values({
          id,
          user_id: userIdOfGumbo(user),
          token_hash: hashToken(token),
          expires_at: new Date(now.getTime() + 3_600_000),
          created_at: now
        })
        .execute()
    }
    for (const [id, name] of [
      ['tem_home', 'Demo Home'],
      ['tem_away', 'Demo Away']
    ]) {
      await db
        .insertInto('teams')
        .values({ id, name, created_at: now, updated_at: now })
        .execute()
    }
    for (const id of [
      'gam_1',
      'gam_3',
      'gam_4',
      'gam_5',
      'gam_6',
      // One game per case that counts cameras, so a case cannot be read by
      // what the one before it left behind.
      'gam_7',
      'gam_8',
      'gam_9',
      'gam_10',
      'gam_11',
      'gam_12',
      'gam_13',
      'gam_14',
      'gam_15',
      'gam_16'
    ]) {
      await db
        .insertInto('games')
        .values({
          id,
          home_team_id: 'tem_home',
          away_team_id: 'tem_away',
          start_at: now,
          created_at: now,
          updated_at: now
        })
        .execute()
    }
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_manager',
        user_id: userIdOfGumbo(managerId),
        team_id: 'tem_home',
        role: 'manager'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_coach',
        user_id: userIdOfGumbo(coachId),
        team_id: 'tem_home',
        role: 'manager'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_parent',
        user_id: userIdOfGumbo(parentId),
        team_id: 'tem_home',
        role: 'member'
      })
      .execute()
    // A videographer of the away team and a scorekeeper of the home team,
    // each a member of the team they hold it on.
    for (const [userId, teamId, role] of [
      [filmerId, 'tem_away', 'videographer'],
      [scorerId, 'tem_home', 'scorekeeper']
    ] as const) {
      await db
        .insertInto('memberships')
        .values({
          id: `mem_${role}`,
          user_id: userIdOfGumbo(userId),
          team_id: teamId
        })
        .execute()
      await db
        .insertInto('scope_roles')
        .values({
          id: `rol_${role}`,
          user_id: userIdOfGumbo(userId),
          scope_type: 'team',
          scope_id: teamId,
          role
        })
        .execute()
    }
  }

  async function ask(
    path: string,
    token: string,
    method = 'GET'
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      }
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    }
  }

  async function send(
    path: string,
    token: string,
    method: string,
    body: unknown
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    }
  }

  async function cameraRow(streamId: string): Promise<{
    label: string | null
    title: string | null
    videoId: string | null
  }> {
    const stream = await db
      ?.selectFrom('live_streams')
      .select(['label', 'video_id as videoId'])
      .where('id', '=', streamId)
      .executeTakeFirst()
    if (stream == null) throw new Error(`no stream ${streamId}`)
    if (stream.videoId == null) {
      return { label: stream.label, title: null, videoId: null }
    }
    const video = await db
      ?.selectFrom('videos')
      .select(['title'])
      .where('id', '=', stream.videoId)
      .executeTakeFirst()
    return {
      label: stream.label,
      title: video?.title ?? null,
      videoId: stream.videoId
    }
  }

  it('gives a person a URL with their own key in it', async function () {
    if (db == null) this.skip()
    const made = await ask('/games/gam_1/live-streams', MANAGER, 'POST')
    expect(made.status).equals(201)
    const url = String(made.body.url)
    // One field, one paste: the whole address, key and all, the way
    // other services print theirs.
    expect(url.startsWith('rtmp://live.example:1936/live/ts_')).equals(true)
    expect(made.body.label).equals('Camera 1')
    expect(made.body.ownerName).equals('Casey Manager')

    // And the list afterwards says what it is without saying the key.
    const asked = await ask('/games/gam_1/live-streams', MANAGER)
    expect(asked.status).equals(200)
    const list = asked.body as unknown as {
      mine: Array<Record<string, unknown>>
      others: unknown[]
      canAdd: number
    }
    expect(list.mine.length).equals(1)
    expect(list.others.length).equals(0)
    expect(list.canAdd).equals(3)
    expect(list.mine[0].url, 'no key in an answer nobody asked for').equals(
      undefined
    )
    expect(String(list.mine[0].keyPrefix).startsWith('ts_')).equals(true)
  })

  it('gives each person their own key for the same game', async function () {
    if (db == null) this.skip()
    const mine = await ask('/games/gam_5/live-streams', MANAGER, 'POST')
    const theirs = await ask('/games/gam_5/live-streams', COACH, 'POST')
    expect(theirs.status).equals(201)
    // Two people, two keys, one game — which is the whole point: the game can
    // now say who is streaming it.
    expect(theirs.body.url).does.not.equal(mine.body.url)

    const asked = await ask('/games/gam_5/live-streams', COACH)
    const list = asked.body as unknown as {
      mine: Array<Record<string, unknown>>
      others: Array<Record<string, unknown>>
    }
    expect(list.mine.length).equals(1)
    expect(list.others.length).equals(1)
    // Theirs is named, and only named.
    expect(list.others[0].ownerName).equals('Casey Manager')
    expect(list.others[0].url).equals(undefined)
    expect(String(list.others[0].keyPrefix).startsWith('ts_')).equals(true)
  })

  it('will not show one person another person’s key', async function () {
    if (db == null) this.skip()
    const list = (await ask('/games/gam_1/live-streams', COACH))
      .body as unknown as { others: Array<{ id: string }> }
    const theirs = list.others[0].id
    for (const path of [
      `/games/gam_1/live-streams/${theirs}/reveal`,
      `/games/gam_1/live-streams/${theirs}/rotate`
    ]) {
      const answer = await ask(path, COACH, 'POST')
      expect(answer.status, path).equals(404)
    }
  })

  it('lets four cameras on one game, and refuses the fifth', async function () {
    if (db == null) this.skip()
    // Its own game, so what the other cases did cannot bias the count.
    for (let camera = 1; camera <= 4; camera += 1) {
      const more = await ask('/games/gam_4/live-streams', MANAGER, 'POST')
      expect(more.status, `camera ${camera}`).equals(201)
      expect(more.body.label).equals(`Camera ${camera}`)
    }
    const fifth = await ask('/games/gam_4/live-streams', MANAGER, 'POST')
    expect(fifth.status).equals(400)
    expect(String(fifth.body.message)).contains('4 cameras')

    const asked = await ask('/games/gam_4/live-streams', MANAGER)
    const list = asked.body as unknown as { mine: unknown[]; canAdd: number }
    expect(list.mine.length).equals(4)
    expect(list.canAdd).equals(0)
  })

  it('gives an ended camera’s number back to the next one', async function () {
    if (db == null) this.skip()
    const list = (await ask('/games/gam_4/live-streams', MANAGER))
      .body as unknown as { mine: Array<{ id: string; slot: number }> }
    const third = list.mine.find(row => row.slot === 3)
    await db
      ?.updateTable('live_streams')
      .set({ state: 'revoked', updated_at: new Date() })
      .where('id', '=', third?.id ?? '')
      .execute()

    const again = await ask('/games/gam_4/live-streams', MANAGER, 'POST')
    expect(again.status).equals(201)
    expect(again.body.label, 'the gap is filled, not appended to').equals(
      'Camera 3'
    )
  })

  it('ends one camera without touching the others', async function () {
    if (db == null) this.skip()
    // Its own game, and its own two cameras.
    const first = await ask('/games/gam_6/live-streams', MANAGER, 'POST')
    const second = await ask('/games/gam_6/live-streams', MANAGER, 'POST')
    expect(second.status).equals(201)

    const ended = await ask(
      `/games/gam_6/live-streams/${String(second.body.id)}/end`,
      MANAGER,
      'POST'
    )
    expect(ended.status).equals(200)
    expect(Date.parse(String(ended.body.closesAt))).lessThanOrEqual(Date.now())

    const after = (await ask('/games/gam_6/live-streams', MANAGER))
      .body as unknown as {
      mine: Array<{ id: string; closesAt: string | null }>
    }
    const untouched = after.mine.find(row => row.id === String(first.body.id))
    // Null, because a key has no clock: the one that was ended carries the
    // moment somebody ended it, and this one carries nothing.
    expect(untouched?.closesAt, 'the other camera is untouched').equals(null)
  })

  it('removes a camera, and gives its number back', async function () {
    if (db == null) this.skip()
    // Its own game, so the count is this case's and nobody else's.
    const first = await ask('/games/gam_7/live-streams', MANAGER, 'POST')
    const second = await ask('/games/gam_7/live-streams', MANAGER, 'POST')
    expect(second.status).equals(201)
    expect(second.body.label).equals('Camera 2')

    const after = await ask(
      `/games/gam_7/live-streams/${String(second.body.id)}`,
      MANAGER,
      'DELETE'
    )
    expect(after.status).equals(200)
    const list = after.body as unknown as {
      mine: Array<{ id: string }>
      canAdd: number
    }
    // Gone from the list, not sitting in it saying "ended" for ever — which
    // is the whole difference between removing a camera and ending one.
    expect(list.mine.map(row => row.id)).deep.equals([String(first.body.id)])
    expect(list.canAdd, 'the slot came back').equals(3)

    const again = await ask('/games/gam_7/live-streams', MANAGER, 'POST')
    expect(again.body.label, 'and the number with it').equals('Camera 2')
  })

  it('takes the empty recording with it, and leaves one that has video', async function () {
    if (db == null) this.skip()
    const made = await ask('/games/gam_8/live-streams', MANAGER, 'POST')
    const emptyVideo = (
      await db
        ?.selectFrom('live_streams')
        .select(['video_id'])
        .where('id', '=', String(made.body.id))
        .executeTakeFirst()
    )?.video_id
    expect(emptyVideo, 'a key is made with somewhere to write').not.equals(null)

    await ask(
      `/games/gam_8/live-streams/${String(made.body.id)}`,
      MANAGER,
      'DELETE'
    )
    const gone = await db
      ?.selectFrom('videos')
      .select(['id'])
      .where('id', '=', emptyVideo ?? '')
      .executeTakeFirst()
    expect(gone, 'a recording that never happened goes too').equals(undefined)

    // Now one that did record something.
    const second = await ask('/games/gam_8/live-streams', MANAGER, 'POST')
    const kept = (
      await db
        ?.selectFrom('live_streams')
        .select(['video_id'])
        .where('id', '=', String(second.body.id))
        .executeTakeFirst()
    )?.video_id
    await db
      ?.updateTable('videos')
      .set({ duration_sec: 1200, hidden: false, updated_at: new Date() })
      .where('id', '=', kept ?? '')
      .execute()

    await ask(
      `/games/gam_8/live-streams/${String(second.body.id)}`,
      MANAGER,
      'DELETE'
    )
    const still = await db
      ?.selectFrom('videos')
      .select(['id'])
      .where('id', '=', kept ?? '')
      .executeTakeFirst()
    // The key is a credential and the recording is a game. Tidying up the
    // first is not permission to throw away the second.
    expect(still?.id, 'the recording stays').equals(kept)
  })

  it('will not let one person remove another person’s camera', async function () {
    if (db == null) this.skip()
    const mine = await ask('/games/gam_9/live-streams', MANAGER, 'POST')
    const answer = await ask(
      `/games/gam_9/live-streams/${String(mine.body.id)}`,
      COACH,
      'DELETE'
    )
    // 404, not 403: another person's camera id is not something to confirm.
    expect(answer.status).equals(404)
  })

  it('will not remove a camera that is streaming', async function () {
    if (db == null) this.skip()
    const made = await ask('/games/gam_10/live-streams', MANAGER, 'POST')
    await db
      ?.updateTable('live_streams')
      .set({ state: 'publishing', updated_at: new Date() })
      .where('id', '=', String(made.body.id))
      .execute()

    const answer = await ask(
      `/games/gam_10/live-streams/${String(made.body.id)}`,
      MANAGER,
      'DELETE'
    )
    // Pulling the row out from under a running ffmpeg is how a playlist ends
    // up half written.
    expect(answer.status).equals(400)
    expect(String(answer.body.message)).contains('End it first')
  })

  it('lets the person whose camera it was delete the recording', async function () {
    if (db == null) this.skip()
    const made = await ask('/games/gam_11/live-streams', MANAGER, 'POST')
    const videoId = (
      await db
        ?.selectFrom('live_streams')
        .select(['video_id'])
        .where('id', '=', String(made.body.id))
        .executeTakeFirst()
    )?.video_id
    await db
      ?.updateTable('videos')
      .set({ duration_sec: 90, hidden: false, updated_at: new Date() })
      .where('id', '=', videoId ?? '')
      .execute()

    const notices = await listenScreenScopes(db)
    const mark = notices.mark()
    const gone = await ask(`/videos/${videoId ?? ''}`, MANAGER, 'DELETE')
    expect(gone.status).equals(200)
    // One transaction, and the game's event is told as it commits.
    await notices.named(mark, { gameId: 'gam_11' })
    await notices.close()

    const row = await db
      ?.selectFrom('videos')
      .select(['id'])
      .where('id', '=', videoId ?? '')
      .executeTakeFirst()
    expect(row, 'the recording is gone').equals(undefined)

    // The camera keeps its row — it is the record that a key existed — and
    // stops pointing at a recording that is not there.
    const camera = await db
      ?.selectFrom('live_streams')
      .select(['video_id'])
      .where('id', '=', String(made.body.id))
      .executeTakeFirst()
    expect(camera?.video_id).equals(null)
  })

  it('will not let a stranger delete somebody’s recording', async function () {
    if (db == null) this.skip()
    const made = await ask('/games/gam_12/live-streams', MANAGER, 'POST')
    const videoId = (
      await db
        ?.selectFrom('live_streams')
        .select(['video_id'])
        .where('id', '=', String(made.body.id))
        .executeTakeFirst()
    )?.video_id

    const answer = await ask(`/videos/${videoId ?? ''}`, PARENT, 'DELETE')
    // 404 rather than 403: that a recording exists is not something to confirm
    // to somebody who may not touch it.
    expect(answer.status).equals(404)
  })

  it('refuses to delete a recording that is still being written', async function () {
    if (db == null) this.skip()
    const made = await ask('/games/gam_13/live-streams', MANAGER, 'POST')
    const videoId = (
      await db
        ?.selectFrom('live_streams')
        .select(['video_id'])
        .where('id', '=', String(made.body.id))
        .executeTakeFirst()
    )?.video_id
    await db
      ?.updateTable('live_streams')
      .set({ state: 'publishing', updated_at: new Date() })
      .where('id', '=', String(made.body.id))
      .execute()

    const answer = await ask(`/videos/${videoId ?? ''}`, MANAGER, 'DELETE')
    expect(answer.status).equals(400)
    expect(String(answer.body.message)).contains('End the camera first')
  })

  it('refuses a legacy recording, which lives in a tree it does not own', async function () {
    if (db == null) this.skip()
    await db
      ?.insertInto('videos')
      .values({
        id: 'vid_legacy',
        game_id: 'gam_1',
        kind: 'combined',
        title: 'An old one',
        storage: 'peertube',
        status: 'ready',
        created_at: new Date(),
        updated_at: new Date()
      })
      .execute()

    const answer = await ask('/videos/vid_legacy', MANAGER, 'DELETE')
    expect(answer.status).equals(400)
    expect(String(answer.body.message)).contains('old server')
  })

  it('renames a camera, and ignores a key it does not know', async function () {
    if (db == null) this.skip()
    const list = (await ask('/games/gam_6/live-streams', MANAGER))
      .body as unknown as { mine: Array<{ id: string; slot: number }> }
    const first = list.mine.find(row => row.slot === 1)

    // An older client may still send a switch this server no longer has.
    const renamed = await fetch(
      `${base}/games/gam_6/live-streams/${first?.id ?? ''}`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${MANAGER}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ onward: true, label: 'Dugout' })
      }
    )
    expect(renamed.status).equals(200)
    const body = (await renamed.json()) as Record<string, unknown>
    expect(body.label).equals('Dugout')
    expect(body).not.to.have.any.keys('onward')
  })

  it('tells a parent nothing at all, not even that it exists', async function () {
    if (db == null) this.skip()
    for (const [path, method] of [
      ['/games/gam_1/live-streams', 'GET'],
      ['/games/gam_1/live-streams', 'POST']
    ]) {
      const answer = await ask(path, PARENT, method)
      expect(answer.status, `${method} ${path}`).equals(404)
    }
  })

  it('lets a videographer of either team stream, and not a scorekeeper', async function () {
    if (db == null) this.skip()
    const made = await ask('/games/gam_14/live-streams', FILMER, 'POST')
    expect(made.status).equals(201)
    const listed = await ask('/games/gam_14/live-streams', FILMER)
    expect(listed.status).equals(200)
    for (const [path, method] of [
      ['/games/gam_14/live-streams', 'GET'],
      ['/games/gam_14/live-streams', 'POST']
    ]) {
      const answer = await ask(path, SCORER, method)
      expect(answer.status, `${method} ${path}`).equals(404)
    }
  })

  it('turns a stranger away', async function () {
    if (db == null) this.skip()
    const answer = await ask('/games/gam_1/live-streams', 'tok_nobody', 'GET')
    expect(answer.status).equals(401)
  })

  it('rotating gives a different key, and the old one is gone', async function () {
    if (db == null) this.skip()
    const list = (await ask('/games/gam_1/live-streams', MANAGER))
      .body as unknown as { mine: Array<{ id: string; slot: number }> }
    const first = list.mine.find(row => row.slot === 1)
    const path = `/games/gam_1/live-streams/${first?.id ?? ''}`
    const before = await ask(`${path}/reveal`, MANAGER, 'POST')
    const rotated = await ask(`${path}/rotate`, MANAGER, 'POST')
    expect(rotated.status).equals(200)
    expect(rotated.body.url).does.not.equal(before.body.url)

    const after = await ask(`${path}/reveal`, MANAGER, 'POST')
    expect(after.body.url).equals(rotated.body.url)
  })

  it('will not hand out a key on a server with live switched off', async function () {
    if (db == null) this.skip()
    // The same database behind a router with `enabled: false`, which is how a
    // deployment that has not opened the ingest port yet is configured.
    const off = express()
    off.use(express.json())
    off.use(withActor(db))
    off.use(withAudit(db))
    off.use(
      '/api/v1',
      liveRoutes(db, {
        live: {
          enabled: false,
          bindHost: '0.0.0.0',
          port: 1936,
          app: 'live',
          segmentSeconds: 4,
          freeDiskFloorGb: 10
        },
        sessionSecret: 'k'.repeat(32),
        host: 'live.example'
      })
    )
    off.use(errorHandler)
    const server = off.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const answer = await fetch(
        `http://127.0.0.1:${port}/api/v1/games/gam_3/live-streams`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${MANAGER}`,
            'content-type': 'application/json'
          }
        }
      )
      const body = (await answer.json()) as { message?: string }
      expect(answer.status).equals(400)
      expect(body.message ?? '').contains('switched off')
      const rows = await db
        ?.selectFrom('live_streams')
        .select(['id'])
        .where('game_id', '=', 'gam_3')
        .execute()
      expect(rows?.length).equals(0)
    } finally {
      server.close()
    }
  })

  it('lists a game being played for the people who may watch it', async function () {
    if (db == null) this.skip()
    const now = new Date()
    await db
      ?.insertInto('videos')
      .values({
        id: 'vid_onNow',
        game_id: 'gam_1',
        kind: 'live',
        title: 'Demo Away at Demo Home',
        storage: 'local',
        status: 'live',
        hidden: false,
        start_at: now,
        created_at: now,
        updated_at: now
      })
      .execute()

    // The parent who may not have the key is exactly the person the stream is
    // for: they see the game, and nothing about how it is being published.
    for (const token of [MANAGER, PARENT]) {
      const answer = await ask('/live', token)
      expect(answer.status).equals(200)
      const live = answer.body as unknown as Array<Record<string, unknown>>
      expect(live.length).equals(1)
      expect(live[0].videoId).equals('vid_onNow')
      expect(live[0].homeTeamName).equals('Demo Home')
      expect(JSON.stringify(live[0])).does.not.contain('ts_')
    }
    // Home's scope gates this read, so it answers the revision its rows
    // were read at, as the other reads of Home's load do.
    const read = await fetch(`${base}/live`, {
      headers: { authorization: `Bearer ${MANAGER}` }
    })
    expect(read.status).equals(200)
    expect(read.headers.get(REVISION_HEADER)).equals(await readSyncClock(db))
  })

  it('stores a camera name on the stream and on its video', async function () {
    if (db == null) this.skip()
    const blank = await send('/games/gam_15/live-streams', MANAGER, 'POST', {
      label: '   '
    })
    expect(blank.status).equals(201)
    expect(blank.body.label).equals('Camera 1')
    const blankRow = await cameraRow(String(blank.body.id))
    expect(blankRow.label).equals(null)
    expect(blankRow.title?.endsWith(' — Camera 1')).equals(true)

    const made = await send('/games/gam_15/live-streams', MANAGER, 'POST', {
      label: '  First Base  '
    })
    expect(made.status).equals(201)
    expect(made.body.label).equals('First Base')
    const named = await cameraRow(String(made.body.id))
    expect(named.label).equals('First Base')
    expect(named.title?.endsWith(' — First Base')).equals(true)
    expect(named.title?.startsWith('Demo Away at Demo Home — ')).equals(true)
    const angles = angleLabels([
      {
        id: named.videoId ?? '',
        title: named.title ?? '',
        status: 'processing',
        numCameras: 1,
        durationSec: null
      }
    ])
    expect(angles[0].name).equals('First Base')

    const hyphen = await send('/games/gam_15/live-streams', MANAGER, 'POST', {
      label: 'First-Base'
    })
    expect(hyphen.status).equals(201)
    expect(hyphen.body.label).equals('First-Base')
    const dash = await send('/games/gam_15/live-streams', MANAGER, 'POST', {
      label: 'Left—Field'
    })
    expect(dash.status).equals(201)
    expect(dash.body.label).equals('Left—Field')
  })

  it('refuses a camera name that is too long or contains the angle separator', async function () {
    if (db == null) this.skip()
    const exact = 'A'.repeat(80)
    const padded = ` ${'B'.repeat(80)} `
    const tooLong = 'C'.repeat(81)

    const first = await send('/games/gam_16/live-streams', MANAGER, 'POST', {
      label: exact
    })
    expect(first.status).equals(201)
    expect(first.body.label).equals(exact)
    expect(
      (await cameraRow(String(first.body.id))).title?.endsWith(` — ${exact}`)
    ).equals(true)

    const second = await send('/games/gam_16/live-streams', MANAGER, 'POST', {
      label: padded
    })
    expect(second.status).equals(201)
    expect(second.body.label).equals('B'.repeat(80))

    const refused = await send('/games/gam_16/live-streams', MANAGER, 'POST', {
      label: ` ${tooLong} `
    })
    expect(refused.status).equals(400)
    expect(String(refused.body.message)).equals(
      'A camera name can be at most 80 characters.'
    )
    const split = await send('/games/gam_16/live-streams', MANAGER, 'POST', {
      label: 'Home — Plate'
    })
    expect(split.status).equals(400)
    expect(String(split.body.message)).equals(
      'A camera name cannot contain " — ".'
    )
    const still = await cameraRow(String(first.body.id))
    expect(still.label).equals(exact)

    const path = `/games/gam_16/live-streams/${String(first.body.id)}`
    const patchLong = await send(path, MANAGER, 'PATCH', {
      label: ` ${tooLong}`
    })
    expect(patchLong.status).equals(400)
    expect(String(patchLong.body.message)).equals(
      'A camera name can be at most 80 characters.'
    )
    expect((await cameraRow(String(first.body.id))).label).equals(exact)

    const patchSplit = await send(path, MANAGER, 'PATCH', {
      label: 'Home — Plate'
    })
    expect(patchSplit.status).equals(400)
    expect(String(patchSplit.body.message)).equals(
      'A camera name cannot contain " — ".'
    )
    expect(
      (await cameraRow(String(first.body.id))).title?.endsWith(` — ${exact}`)
    ).equals(true)

    const renamed = await send(path, MANAGER, 'PATCH', { label: 'Dugout' })
    expect(renamed.status).equals(200)
    expect(renamed.body.label).equals('Dugout')
    const afterRename = await cameraRow(String(first.body.id))
    expect(afterRename.label).equals('Dugout')
    expect(afterRename.title).equals('Demo Away at Demo Home — Dugout')

    const cleared = await send(path, MANAGER, 'PATCH', { label: '  ' })
    expect(cleared.status).equals(200)
    expect(cleared.body.label).equals('Camera 1')
    const afterClear = await cameraRow(String(first.body.id))
    expect(afterClear.label).equals(null)
    expect(afterClear.title).equals('Demo Away at Demo Home — Camera 1')

    const eighty = await send(path, MANAGER, 'PATCH', { label: padded })
    expect(eighty.status).equals(200)
    expect(eighty.body.label).equals('B'.repeat(80))
    expect(
      (await cameraRow(String(first.body.id))).title?.endsWith(
        ` — ${'B'.repeat(80)}`
      )
    ).equals(true)

    await db
      ?.updateTable('videos')
      .set({ title: 'Just a game', updated_at: new Date() })
      .where('id', '=', afterClear.videoId ?? '')
      .execute()
    const plain = await send(path, MANAGER, 'PATCH', { label: 'Mound' })
    expect(plain.status).equals(200)
    expect((await cameraRow(String(first.body.id))).title).equals(
      'Just a game — Mound'
    )

    await db
      ?.updateTable('live_streams')
      .set({ video_id: null, updated_at: new Date() })
      .where('id', '=', String(first.body.id))
      .execute()
    const noVideo = await send(path, MANAGER, 'PATCH', { label: 'Bullpen' })
    expect(noVideo.status).equals(200)
    expect(noVideo.body.label).equals('Bullpen')
    expect((await cameraRow(String(first.body.id))).label).equals('Bullpen')
  })
})
