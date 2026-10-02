import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import type { SpaceSettings } from '../media/spacesHls'
import type { LiveControllerOptions } from './controller'
import { liveVideoDir, sweepLocalCopies } from './controller'

/**
 * The two jobs of the five-minute round: letting go of a local copy the Space
 * has, and trying again for one it never took.
 *
 * Against a real database, because both are questions about rows — which
 * video is past its grace, which is still waiting — and a stub that answered
 * them would be the thing under test. It skips where there is no Postgres, the
 * way the migration suite does.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_sweep_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

/** Older than the fifteen minutes a failed upload waits before a retry. */
const LONG_AGO = new Date(Date.now() - 3_600_000)

describe('the live sweep', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let mediaRoot = ''
  let space: Server | undefined
  let held = new Map<string, Buffer>()
  let options: LiveControllerOptions | undefined

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

    mediaRoot = await mkdtemp(join(tmpdir(), 'tsSweep-'))
    space = createServer((req, res) => {
      const key = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(chunk as Buffer))
        req.on('end', () => {
          held.set(key, Buffer.concat(chunks))
          res.writeHead(200).end()
        })
        return
      }
      const body = held.get(key)
      if (body == null) {
        res.writeHead(404).end()
        return
      }
      // The verifier asks for one byte and reads the length off the answer.
      if (req.headers.range != null) {
        res
          .writeHead(206, {
            'content-range': `bytes 0-0/${body.length}`,
            'content-length': '1'
          })
          .end(body.subarray(0, 1))
        return
      }
      res.writeHead(200, { 'content-length': String(body.length) }).end(body)
    })
    await new Promise<void>(resolve => {
      space?.listen(0, '127.0.0.1', resolve)
    })
    const address = space.address()
    const port =
      typeof address === 'object' && address != null ? address.port : 0
    const settings: SpaceSettings = {
      endpoint: `http://127.0.0.1:${port}`,
      region: 'sfo3',
      bucket: 'teamstation',
      accessKeyId: 'AKIAEXAMPLE000000000',
      secretAccessKey: 'secret',
      pathStyle: true
    }
    options = {
      db,
      live: {
        enabled: true,
        bindHost: '127.0.0.1',
        port: 1936,
        app: 'live',
        segmentSeconds: 4,
        closeAfterHours: 6,
        freeDiskFloorGb: 10
      },
      ffmpegPath: process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg',
      mediaRoot,
      workDir: join(mediaRoot, 'work'),
      sessionSecret: 'a'.repeat(32),
      space: settings,
      log: () => undefined
    }
  })

  after(async function () {
    space?.close()
    if (db != null) await db.destroy()
    if (mediaRoot !== '') await rm(mediaRoot, { recursive: true, force: true })
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  /** A video row, with the files a finished recording is made of. */
  async function makeVideo(
    id: string,
    row: {
      storage: 'local' | 'spaces'
      verifiedAt?: Date | null
      deleteAfter?: Date | null
      updatedAt?: Date
    },
    shape: 'packed' | 'segments'
  ): Promise<void> {
    const dir = liveVideoDir(mediaRoot, id)
    await mkdir(dir, { recursive: true })
    if (shape === 'packed') {
      await writeFile(join(dir, 'video.mp4'), Buffer.alloc(4096, 1))
      await writeFile(join(dir, 'video.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n')
      await writeFile(join(dir, 'master.m3u8'), '#EXTM3U\nvideo.m3u8\n')
    } else {
      await writeFile(join(dir, 'init.mp4'), Buffer.alloc(512, 2))
      await writeFile(join(dir, 'seg000000.m4s'), Buffer.alloc(512, 3))
      await writeFile(join(dir, 'master.m3u8'), '#EXTM3U\nseg000000.m4s\n')
    }
    await db
      ?.insertInto('videos')
      .values({
        id,
        kind: 'live',
        title: id,
        storage: row.storage,
        status: 'ready',
        spaces_verified_at: row.verifiedAt ?? null,
        local_delete_after: row.deleteAfter ?? null,
        created_at: row.updatedAt ?? LONG_AGO,
        updated_at: row.updatedAt ?? LONG_AGO
      })
      .execute()
  }

  async function storageOf(id: string): Promise<string | undefined> {
    const row = await db
      ?.selectFrom('videos')
      .select(['storage'])
      .where('id', '=', id)
      .executeTakeFirst()
    return row?.storage
  }

  it('deletes a local copy only when the Space has it and the grace is up', async function () {
    if (options == null) this.skip()
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 3_600_000)
    await makeVideo(
      'vid_gone',
      { storage: 'spaces', verifiedAt: LONG_AGO, deleteAfter: past },
      'packed'
    )
    await makeVideo(
      'vid_stillWatched',
      { storage: 'spaces', verifiedAt: LONG_AGO, deleteAfter: future },
      'packed'
    )
    // Left as segments so the retry in the same round passes it over, and
    // this case stays about the sweep alone.
    await makeVideo(
      'vid_neverWent',
      { storage: 'local', deleteAfter: past },
      'segments'
    )

    await sweepLocalCopies(options)

    const gone = await stat(liveVideoDir(mediaRoot, 'vid_gone')).catch(
      () => undefined
    )
    expect(gone, 'the copy the Space has is deleted').equals(undefined)
    expect(
      (await stat(liveVideoDir(mediaRoot, 'vid_stillWatched'))).isDirectory(),
      'a copy still inside its grace is kept'
    ).equals(true)
    expect(
      (await stat(liveVideoDir(mediaRoot, 'vid_neverWent'))).isDirectory(),
      'a copy the Space does not have is never deleted'
    ).equals(true)

    // And the deadline is cleared, so the same directory is not swept twice.
    const row = await db
      ?.selectFrom('videos')
      .select(['local_delete_after as deleteAfter'])
      .where('id', '=', 'vid_gone')
      .executeTakeFirst()
    expect(row?.deleteAfter).equals(null)
  })

  it('a recording that could not be packed does not block the next one', async function () {
    if (options == null) this.skip()
    held = new Map()
    // The older of the two is the broken one, so it is the one the retry
    // reaches first. Before, it was the only one it ever reached.
    await makeVideo(
      'vid_broken',
      { storage: 'local', updatedAt: new Date(Date.now() - 7_200_000) },
      'segments'
    )
    await makeVideo('vid_packed', { storage: 'local' }, 'packed')

    await sweepLocalCopies(options)

    expect(await storageOf('vid_packed'), 'the packed one goes').equals(
      'spaces'
    )
    expect(await storageOf('vid_broken'), 'the broken one stays here').equals(
      'local'
    )
    expect(
      [...held.keys()].some(key => key.includes('vid_packed/video.mp4')),
      'the Space was actually written to'
    ).equals(true)
  })
})
