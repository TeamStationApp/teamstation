import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import {
  PART_SIZE,
  receivedParts,
  reopenInterruptedUploads,
  uploadDir
} from '../director/uploads'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { directorUploadRoutes, replaceLiveRecording } from './directorUploads'

/**
 * A Director sending its recording in.
 *
 * What is proved here is the part of it that has nothing to do with video:
 * whose upload it is, what has landed, what is still missing, and what the
 * live recording does when a better copy of the same game arrives. Turning
 * the file into HLS needs ffmpeg and a Space, and is exercised against a
 * running server rather than here.
 */
const adminUrl =
  process.env.GS_TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres'
const scratchName = `gamestation_uploads_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const COACH = 'tok_coach_upload_000000000000000'
const PARENT = 'tok_parent_upload_00000000000000'
const HOUR = 3_600_000

describe('a Director sending a recording in', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  let mediaDir = ''

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
    mediaDir = await mkdtemp(join(tmpdir(), 'gsUploadRoutes-'))

    const app = express()
    app.use(express.json())
    app.use(withActor(db))
    app.use(withAudit(db))
    app.use(
      '/api/v1',
      directorUploadRoutes(db, {
        uploadsDir: mediaDir,
        ffmpegPath: '/usr/bin/ffmpeg',
        space: {
          bucket: 'test',
          region: 'sfo3',
          endpoint: 'https://sfo3.example',
          accessKeyId: 'k',
          secretAccessKey: 's',
          publicBase: 'https://cdn.example'
        }
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (mediaDir !== '') await rm(mediaDir, { recursive: true, force: true })
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  async function seed(db: Kysely<Database>): Promise<void> {
    const now = new Date()
    for (const [id, name] of [
      ['usr_coach', 'Coach'],
      ['usr_parent', 'Parent']
    ]) {
      await db
        .insertInto('users')
        .values({
          id,
          display_name: name,
          first_name: null,
          last_name: null,
          created_at: now,
          updated_at: now
        })
        .execute()
    }
    for (const [id, user, token] of [
      ['ses_coach', 'usr_coach', COACH],
      ['ses_parent', 'usr_parent', PARENT]
    ]) {
      await db
        .insertInto('auth_sessions')
        .values({
          id,
          user_id: user,
          token_hash: hashToken(token),
          expires_at: new Date(now.getTime() + HOUR),
          created_at: now
        })
        .execute()
    }
    for (const [id, name] of [
      ['tem_ours', 'Ravens'],
      ['tem_theirs', 'Titan'],
      ['tem_strangers', 'Somebody Else']
    ]) {
      await db
        .insertInto('teams')
        .values({ id, name, created_at: now, updated_at: now })
        .execute()
    }
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_coach',
        user_id: 'usr_coach',
        team_id: 'tem_ours',
        role: 'manager'
      })
      .execute()
    for (const [id, home] of [
      ['gam_ours', 'tem_ours'],
      ['gam_notOurs', 'tem_strangers']
    ]) {
      await db
        .insertInto('games')
        .values({
          id,
          home_team_id: home,
          away_team_id: 'tem_theirs',
          start_at: new Date(now.getTime() - 3 * HOUR),
          created_at: now,
          updated_at: now
        })
        .execute()
    }
  }

  /** Headers as a plain record: a `HeadersInit` may be an array of pairs. */
  type Ask = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }

  const ask = async (
    path: string,
    token: string,
    init: Ask = {}
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {})
      }
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text)
    }
  }

  const open = async (
    token = COACH,
    gameId = 'gam_ours',
    sizeBytes = PART_SIZE + 10
  ): Promise<{ status: number; body: any }> =>
    await ask('/director/uploads', token, {
      method: 'POST',
      body: JSON.stringify({
        gameId,
        title: '2026-09-21 Ravens vs Titan',
        filename: 'take-372.mov',
        sizeBytes
      })
    })

  it('opens an upload and says how to send it', async function () {
    const { status, body } = await open()
    expect(status).equals(201)
    expect(body.partSize).equals(PART_SIZE)
    expect(body.parts).equals(2)
    expect(body.received).deep.equals([])
    expect(String(body.uploadId)).matches(/^dup_/)
  })

  it('refuses a game the account does not run', async function () {
    // Not found rather than forbidden: an id is not a thing to confirm.
    expect((await open(COACH, 'gam_notOurs')).status).equals(404)
    expect((await open(PARENT, 'gam_ours')).status).equals(404)
  })

  it('refuses an empty recording', async function () {
    expect((await open(COACH, 'gam_ours', 0)).status).equals(400)
  })

  it('takes the parts and says what is still missing', async function () {
    const { body: made } = await open(COACH, 'gam_ours', PART_SIZE * 2 + 5)
    const id = made.uploadId as string

    // The last one first, which is what a retrying app does.
    const last = await ask(`/director/uploads/${id}/parts/2`, COACH, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(5)
    })
    expect(last.status).equals(200)
    expect(last.body.missing).deep.equals([0, 1])

    const asked = await ask(`/director/uploads/${id}`, COACH)
    expect(asked.body.received).deep.equals([2])
    expect(asked.body.receivedBytes).equals(5)
  })

  it('refuses a part that is the wrong length', async function () {
    const { body: made } = await open()
    const id = made.uploadId as string
    // A short part assembles into a recording that plays until it does not.
    const short = await ask(`/director/uploads/${id}/parts/0`, COACH, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(1000)
    })
    expect(short.status).equals(400)
    expect(String(short.body.message)).contains('should be')
    expect(await receivedParts(uploadDir(mediaDir, id))).deep.equals([])
  })

  it('refuses a part that is not in the recording at all', async function () {
    const { body: made } = await open()
    const id = made.uploadId as string
    const beyond = await ask(`/director/uploads/${id}/parts/9`, COACH, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(10)
    })
    expect(beyond.status).equals(400)
  })

  it('will not finish a recording with parts outstanding', async function () {
    const { body: made } = await open()
    const id = made.uploadId as string
    const finish = await ask(`/director/uploads/${id}/finish`, COACH, {
      method: 'POST',
      body: '{}'
    })
    expect(finish.status).equals(400)
    expect(String(finish.body.message)).contains('2 parts have not arrived')
  })

  it('answers the finish at once and works behind it', async function () {
    // The work is minutes — assemble, probe, remux, copy — and it used to
    // happen inside this request. An app on a ball field cannot hold a
    // request open that long and did not: it timed out, called a landed
    // upload failed, and in the Distributor stopped the rest of the export.
    const { body: made } = await open(COACH, 'gam_ours', 10)
    const id = made.uploadId as string
    await ask(`/director/uploads/${id}/parts/0`, COACH, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(10)
    })

    const began = Date.now()
    const finish = await ask(`/director/uploads/${id}/finish`, COACH, {
      method: 'POST',
      body: '{}'
    })

    expect(finish.status).equals(202)
    expect(finish.body.videoId ?? null).equals(null)
    expect(String(finish.body.state)).equals('assembling')
    // Answered, not worked through: this is a ten-byte file and there is no
    // real ffmpeg here, but the point is the answer does not wait on either.
    expect(Date.now() - began).lessThan(5000)
  })

  it('puts an upload the server died mid-conversion back where it can be asked for again', async function () {
    // Taking an upload in happens behind the request, so a deploy in the
    // middle leaves a row saying `assembling` that nothing will ever move.
    // Every part is still on disk, so it goes back to `open` rather than
    // `failed`: asking again costs the conversion, not the upload.
    const { body: made } = await open()
    const id = made.uploadId as string
    await db
      ?.updateTable('director_uploads')
      .set({ state: 'assembling', step: 'remuxing' })
      .where('id', '=', id)
      .execute()

    const reopened = await reopenInterruptedUploads(db!)
    expect(reopened).greaterThan(0)

    const after = await ask(`/director/uploads/${id}`, COACH)
    expect(String(after.body.state)).equals('open')
    expect(after.body.step ?? null).equals(null)
    expect(String(after.body.message)).contains('restarted')
  })

  it('takes a failed upload again rather than making it a dead end', async function () {
    // What failed is the conversion, not the transfer: the parts are all
    // still on disk, which is why they are kept. A `failed` upload that
    // refused both more parts and another finish left nine gigabytes that
    // nothing could use and nothing reclaimed, and the operator had to send
    // the whole recording again under a new id.
    const { body: made } = await open(COACH, 'gam_ours', 10)
    const id = made.uploadId as string
    await ask(`/director/uploads/${id}/parts/0`, COACH, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(10)
    })
    await db
      ?.updateTable('director_uploads')
      .set({ state: 'failed', message: 'that recording has no video stream' })
      .where('id', '=', id)
      .execute()

    // Both doors that were shut are open again.
    const part = await ask(`/director/uploads/${id}/parts/0`, COACH, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(10)
    })
    expect(part.status).equals(200)
    const finish = await ask(`/director/uploads/${id}/finish`, COACH, {
      method: 'POST',
      body: '{}'
    })
    expect(finish.status).equals(202)
  })

  it('shows nobody else their upload', async function () {
    const { body: made } = await open()
    const id = made.uploadId as string
    expect((await ask(`/director/uploads/${id}`, PARENT)).status).equals(404)
  })

  it('gives up on one, and takes the parts with it', async function () {
    const { body: made } = await open()
    const id = made.uploadId as string
    await ask(`/director/uploads/${id}/parts/1`, COACH, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(10)
    })
    const gone = await ask(`/director/uploads/${id}`, COACH, {
      method: 'DELETE'
    })
    expect(gone.status).equals(204)
    expect(await receivedParts(uploadDir(mediaDir, id))).deep.equals([])
    const after = await ask(`/director/uploads/${id}`, COACH)
    expect(after.body.state).equals('abandoned')
  })
})

describe('the live stream stepping aside for a better copy', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  const name = `gamestation_replace_${Date.now()}`
  const url = adminUrl.replace(/\/[^/]*$/, `/${name}`)

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
    await admin.query(`create database ${name}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(url)

    const now = new Date()
    await db
      .insertInto('teams')
      .values({ id: 'tem_a', name: 'A', created_at: now, updated_at: now })
      .execute()
    await db
      .insertInto('teams')
      .values({ id: 'tem_b', name: 'B', created_at: now, updated_at: now })
      .execute()
    await db
      .insertInto('games')
      .values({
        id: 'gam_one',
        home_team_id: 'tem_a',
        away_team_id: 'tem_b',
        start_at: now,
        created_at: now,
        updated_at: now
      })
      .execute()
    // Lengths matter: an upload only displaces a recording it actually
    // covers, so every row here has to say how long it is.
    for (const [id, kind, seconds] of [
      ['vid_live', 'live', 7000],
      ['vid_camera', 'program', 7200],
      ['vid_upload', 'program', 7200],
      ['vid_clip', 'program', 107]
    ] as const) {
      await db
        .insertInto('videos')
        .values({
          id,
          game_id: 'gam_one',
          kind,
          title: id,
          storage: 'spaces',
          status: 'ready',
          duration_sec: seconds,
          created_at: now,
          updated_at: now
        })
        .execute()
    }
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  it('refuses to let a clip displace the whole game', async function () {
    if (db == null) this.skip()
    // A 107-second bench recording uploaded to a game hid its two-hour live
    // recording and dated it for deletion. The upload's claim is that it is a
    // better copy of the same game; this one is not a copy of it at all.
    const replaced = await replaceLiveRecording(db, 'gam_one', 'vid_clip')
    expect(replaced).deep.equals([])
    const live = await db
      .selectFrom('videos')
      .select(['hidden', 'purge_after'])
      .where('id', '=', 'vid_live')
      .executeTakeFirst()
    expect(live?.hidden).equals(false)
    expect(live?.purge_after ?? null).equals(null)
  })

  it('hides the live recording, and dates it for deletion', async function () {
    if (db == null) this.skip()
    const replaced = await replaceLiveRecording(db, 'gam_one', 'vid_upload')
    expect(replaced).deep.equals(['vid_live'])

    const row = await db
      .selectFrom('videos')
      .select([
        'hidden',
        'replaced_by as replacedBy',
        'purge_after as purgeAfter'
      ])
      .where('id', '=', 'vid_live')
      .executeTakeFirstOrThrow()
    expect(row.hidden).equals(true)
    expect(row.replacedBy).equals('vid_upload')
    // Thirty days out, not now: a month to notice the wrong game.
    const days = (new Date(row.purgeAfter!).getTime() - Date.now()) / 86_400_000
    expect(days).greaterThan(29).and.lessThan(31)
  })

  it('leaves the game’s other recordings alone', async function () {
    if (db == null) this.skip()
    const camera = await db
      .selectFrom('videos')
      .select(['hidden', 'purge_after as purgeAfter'])
      .where('id', '=', 'vid_camera')
      .executeTakeFirstOrThrow()
    expect(camera.hidden).equals(false)
    expect(camera.purgeAfter).equals(null)
  })

  it('does nothing the second time, so a retry costs nothing', async function () {
    if (db == null) this.skip()
    expect(await replaceLiveRecording(db, 'gam_one', 'vid_upload')).deep.equals(
      []
    )
  })
})
