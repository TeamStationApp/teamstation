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
import { answerListOrDelete } from '../../test/heldSpace'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import type { SpaceSettings } from '../media/spacesHls'
import type { LiveControllerOptions } from './controller'
import { liveVideoDir, settleLiveWork, sweepLocalCopies } from './controller'
import { recordingShape } from './finishVideo'

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
  /** While set, every PUT is answered only once it settles. */
  let gate: Promise<void> | undefined
  let puts = 0
  /** Called on the next PUT, once. */
  let onPut: (() => void) | undefined
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
      if (answerListOrDelete(held, req, res)) return
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(chunk as Buffer))
        req.on('end', () => {
          puts++
          held.set(key, Buffer.concat(chunks))
          onPut?.()
          onPut = undefined
          const answer = (): void => {
            res.writeHead(200).end()
          }
          if (gate == null) answer()
          else gate.then(answer, answer)
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
    await settleLiveWork()
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
      replacedBy?: string
    },
    shape: 'packed' | 'segments' | 'recording' | 'both' | 'halfPacked'
  ): Promise<void> {
    const dir = liveVideoDir(mediaRoot, id)
    await mkdir(dir, { recursive: true })
    if (shape === 'recording' || shape === 'both') {
      // What a finish leaves now: the recording in `recording/`, beside the
      // live pieces it was made from.
      const recording = join(dir, 'recording')
      await mkdir(recording, { recursive: true })
      await writeFile(join(recording, 'init.mp4'), Buffer.alloc(512, 4))
      await writeFile(join(recording, 'seg000000.m4s'), Buffer.alloc(2048, 5))
      await writeFile(
        join(recording, 'video.m3u8'),
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg000000.m4s\n#EXT-X-ENDLIST\n'
      )
      await writeFile(join(recording, 'master.m3u8'), '#EXTM3U\nvideo.m3u8\n')
      await writeFile(join(dir, 'init.mp4'), Buffer.alloc(512, 2))
      await writeFile(join(dir, 'seg000000.m4s'), Buffer.alloc(512, 3))
    }
    if (shape === 'halfPacked') {
      // A finish a crash cut short: live pieces, and a `.vod/` with a
      // playlist and part of its segments.
      await writeFile(join(dir, 'init.mp4'), Buffer.alloc(512, 2))
      await writeFile(join(dir, 'seg000000.m4s'), Buffer.alloc(512, 3))
      await writeFile(join(dir, 'master.m3u8'), '#EXTM3U\nseg000000.m4s\n')
      const out = join(dir, '.vod', 'out')
      await mkdir(out, { recursive: true })
      await writeFile(join(out, 'video.m3u8'), '#EXTM3U\nseg000000.m4s\n')
      await writeFile(join(out, 'master.m3u8'), '#EXTM3U\nvideo.m3u8\n')
      await writeFile(join(out, 'seg000000.m4s'), Buffer.alloc(256, 6))
    }
    if (shape === 'packed' || shape === 'both') {
      await writeFile(join(dir, 'video.mp4'), Buffer.alloc(4096, 1))
      await writeFile(join(dir, 'video.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n')
      await writeFile(join(dir, 'master.m3u8'), '#EXTM3U\nvideo.m3u8\n')
    } else if (shape === 'segments') {
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
        replaced_by: row.replacedBy ?? null,
        hidden: row.replacedBy != null,
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
    // Left as segments of nothing: the retry tries to pack it up, cannot, and
    // leaves it where it is.
    await makeVideo(
      'vid_neverWent',
      { storage: 'local', deleteAfter: past },
      'segments'
    )

    await sweepLocalCopies(options)
    await settleLiveWork()

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
    // And the copy that could not be packed says so, and is not tried again.
    const unpacked = await db
      ?.selectFrom('videos')
      .select(['storage', 'status_message as message'])
      .where('id', '=', 'vid_neverWent')
      .executeTakeFirst()
    expect(unpacked).deep.equals({
      storage: 'local',
      message: 'This recording could not be packed up'
    })
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

    await settleLiveWork()

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

  it('copies a phone upload replaced do not keep a failed recording from the Space', async function () {
    if (options == null) this.skip()
    held = new Map()
    // What Stop and then Upload Recording leaves behind: the live copy is
    // finished while it is already replaced, so it stays `local`, `ready` and
    // in its segments, with an `updated_at` that never moves again. Five of
    // them older than anything else filled the whole window the retry reads.
    await makeVideo('vid_upload', { storage: 'spaces' }, 'packed')
    for (let i = 0; i < 5; i++) {
      await makeVideo(
        `vid_replaced${i}`,
        {
          storage: 'local',
          replacedBy: 'vid_upload',
          updatedAt: new Date(Date.now() - 86_400_000 + i)
        },
        'segments'
      )
    }
    await makeVideo('vid_failed', { storage: 'local' }, 'packed')

    await sweepLocalCopies(options)

    await settleLiveWork()

    expect(
      await storageOf('vid_failed'),
      'the recording the Space never took is tried again'
    ).equals('spaces')
    expect(
      await storageOf('vid_replaced0'),
      'a replaced copy is left for the purge'
    ).equals('local')
  })

  it('sends a recording from recording/, as it lies, and that before a single file beside it', async function () {
    if (options == null) this.skip()
    held = new Map()
    await makeVideo('vid_segmented', { storage: 'local' }, 'recording')
    await sweepLocalCopies(options)
    await settleLiveWork()
    const sent = [...held.keys()].filter(key => key.includes('vid_segmented'))
    expect(
      sent.map(key => key.split('/').at(-1)!).sort((a, b) => a.localeCompare(b))
    ).deep.equals(['init.mp4', 'master.m3u8', 'seg000000.m4s', 'video.m3u8'])
    expect(
      held
        .get(sent.find(key => key.endsWith('/seg000000.m4s'))!)
        ?.equals(Buffer.alloc(2048, 5)),
      "the recording's segment, not the live piece of the same name"
    ).equals(true)
    expect(await storageOf('vid_segmented')).equals('spaces')

    held = new Map()
    await makeVideo('vid_both', { storage: 'local' }, 'both')
    await sweepLocalCopies(options)
    await settleLiveWork()
    const both = [...held.keys()].filter(key => key.includes('vid_both'))
    expect(both.some(key => key.endsWith('/init.mp4'))).equals(true)
    expect(both.some(key => key.endsWith('/video.mp4'))).equals(false)
  })

  it('does not end a sweep while it is still sending, so the next cannot send the same recording', async function () {
    if (options == null) this.skip()
    held = new Map()
    await makeVideo('vid_held', { storage: 'local' }, 'recording')
    let release = (): void => undefined
    gate = new Promise<void>(resolve => {
      release = resolve
    })
    puts = 0
    const putSeen = new Promise<void>(resolve => {
      onPut = resolve
    })
    let ended = false
    const first = sweepLocalCopies(options).then(() => {
      ended = true
    })
    try {
      await putSeen
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(ended, 'the sweep waits for its upload').equals(false)
    } finally {
      release()
      gate = undefined
    }
    await first
    const sent = puts
    expect(await storageOf('vid_held')).equals('spaces')
    await sweepLocalCopies(options)
    await settleLiveWork()
    expect(puts, 'nothing is sent again').equals(sent)
  })

  it('takes back what it sent of a video deleted while it was being sent', async function () {
    if (options == null || db == null) this.skip()
    held = new Map()
    await makeVideo('vid_deleted', { storage: 'local' }, 'recording')
    const rows = db
    const deleted = new Promise<void>(resolve => {
      onPut = () => {
        rows
          .deleteFrom('videos')
          .where('id', '=', 'vid_deleted')
          .execute()
          .then(() => {
            resolve()
          }, resolve)
      }
    })
    // Nothing is answered until the row is gone, so the delete lands mid-send.
    gate = deleted
    try {
      await sweepLocalCopies(options)
      await settleLiveWork()
    } finally {
      gate = undefined
    }
    expect(
      [...held.keys()].filter(key => key.includes('vid_deleted'))
    ).deep.equals([])
  })

  it('takes a finish a crash cut short for unpacked, and never sends it', async function () {
    if (options == null) this.skip()
    held = new Map()
    await makeVideo('vid_halfPacked', { storage: 'local' }, 'halfPacked')
    const dir = liveVideoDir(mediaRoot, 'vid_halfPacked')
    expect(await recordingShape(dir)).equals(null)
    await sweepLocalCopies(options)
    await settleLiveWork()
    expect(
      [...held.keys()].some(key => key.includes('vid_halfPacked')),
      'nothing of it reached the Space'
    ).equals(false)
    expect(await storageOf('vid_halfPacked')).equals('local')
  })
})
