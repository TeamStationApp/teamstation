import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import {
  addGame,
  addPerson,
  addTeam,
  type Person,
  scratchDatabase,
  until
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { ffmpegEncoders } from '../media/ffmpeg'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { clockOffsetOf, directorUploadRoutes } from './directorUploads'

const run = promisify(execFile)
const FFMPEG = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'

/**
 * An upload carries the app's measured server-clock offset from its open to
 * the video it becomes (U19), through real ffmpeg and a stand-in Space: the
 * start is the app's `startAt` moved onto the server's clock, less the
 * pre-roll the file's undeclared AAC priming puts at its head.
 */
describe('an upload that measured the server clock', function () {
  this.timeout(120_000)

  let db: Kysely<Database>
  let drop: (() => Promise<void>) | undefined
  let server: Server | undefined
  let space: Server | undefined
  let base = ''
  let dir = ''
  let take: Buffer
  let filmer: Person
  let gameId = ''
  let gameStart: Date

  before(async function () {
    let encoders: Set<string>
    try {
      encoders = await ffmpegEncoders(FFMPEG)
    } catch {
      this.skip()
      return
    }
    if (!encoders.has('libx264') || !encoders.has('aac')) this.skip()
    dir = await mkdtemp(join(tmpdir(), 'tsUploadClock-'))
    // AAC carried as ADTS declares no priming, so muxed into a .mov it
    // arrives as Director's and Distributor's files do: 2,112 samples at
    // 48 kHz, 44 ms of pre-roll in the remux.
    const adts = join(dir, 'sound.aac')
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000:duration=2',
      '-c:a',
      'aac',
      '-f',
      'adts',
      adts
    ])
    const file = join(dir, 'take.mov')
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=30:duration=2',
      '-i',
      adts,
      '-c:v',
      'libx264',
      '-bf',
      '0',
      '-c:a',
      'copy',
      file
    ])
    take = await readFile(file)

    ;({ db, drop } = await scratchDatabase('upload_clock'))
    filmer = await addPerson(db, 'filmer', { isAdmin: true })
    gameStart = new Date(Date.now() - 3_600_000)
    gameId = await addGame(db, {
      homeTeamId: await addTeam(db, 'Pioneers'),
      awayTeamId: await addTeam(db, 'Visitors'),
      startAt: gameStart
    })

    // A Space that keeps what it is given and answers it back, ranges and all.
    const held = new Map<string, Buffer>()
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
    await new Promise<void>(resolve => space?.listen(0, '127.0.0.1', resolve))
    const spacePort = (space.address() as AddressInfo).port

    const app = express()
    app.use(express.json())
    app.use(withActor(db))
    app.use(
      '/api/v1',
      directorUploadRoutes(db, {
        uploadsDir: join(dir, 'uploads'),
        mediaRoot: join(dir, 'media'),
        ffmpegPath: FFMPEG,
        space: {
          endpoint: `http://127.0.0.1:${spacePort}`,
          region: 'sfo3',
          bucket: 'teamstation',
          accessKeyId: 'AKIAEXAMPLE000000000',
          secretAccessKey: 'secret',
          pathStyle: true
        }
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    const listening = server
    if (listening != null)
      await new Promise(resolve => listening.close(resolve))
    space?.close()
    await drop?.()
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  const ask = async (
    path: string,
    init: RequestInit = {}
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${filmer.token}`,
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined)
      }
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text)
    }
  }

  /** Opens, sends and finishes `take`; answers the upload row and its video. */
  async function upload(fields: Record<string, unknown>): Promise<{
    offset: number | null
    startAt: Date | null
    clockOffset: number | null
  }> {
    const opened = await ask('/director/uploads', {
      method: 'POST',
      body: JSON.stringify({
        gameId,
        title: 'Pioneers vs Visitors',
        filename: 'take.mov',
        sizeBytes: take.length,
        ...fields
      })
    })
    expect(opened.status, JSON.stringify(opened.body)).equals(201)
    expect(opened.body.parts).equals(1)
    const uploadId = String(opened.body.uploadId)
    const sent = await fetch(`${base}/director/uploads/${uploadId}/parts/0`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${filmer.token}`,
        'content-type': 'application/octet-stream'
      },
      body: new Uint8Array(take)
    })
    expect(sent.status).equals(200)
    const finished = await ask(`/director/uploads/${uploadId}/finish`, {
      method: 'POST'
    })
    expect(finished.status).equals(202)
    let state: any
    await until(
      'the upload is taken in',
      async () => {
        state = (await ask(`/director/uploads/${uploadId}`)).body
        return state.state === 'ready' || state.state === 'failed'
      },
      60_000
    )
    expect(state.state, String(state.message)).equals('ready')
    const row = await db
      .selectFrom('director_uploads')
      .select('server_clock_offset_ms as offset')
      .where('id', '=', uploadId)
      .executeTakeFirstOrThrow()
    const video = await db
      .selectFrom('videos')
      .select([
        'start_at as startAt',
        'start_at_clock_offset_ms as clockOffset'
      ])
      .where('id', '=', String(state.videoId))
      .executeTakeFirstOrThrow()
    return {
      offset: row.offset,
      startAt: video.startAt == null ? null : new Date(video.startAt),
      clockOffset: video.clockOffset
    }
  }

  const startedAt = new Date(Date.now() - 1_800_000)
  const preRollMs = Math.round((2112 / 48000) * 1000)

  it('moves the start onto the server clock by the offset, less the pre-roll', async function () {
    const made = await upload({
      startAt: startedAt.toISOString(),
      serverClockOffsetMs: 1234
    })
    expect(made.offset).equals(1234)
    expect(made.clockOffset).equals(1234)
    expect(made.startAt?.getTime()).equals(
      startedAt.getTime() + 1234 - preRollMs
    )
  })

  it('leaves the start as the app said without one', async function () {
    const made = await upload({ startAt: startedAt.toISOString() })
    expect(made.offset).equals(null)
    expect(made.clockOffset).equals(null)
    expect(made.startAt?.getTime()).equals(startedAt.getTime() - preRollMs)
  })

  it("never moves the game's own start, which is not on the app's clock", async function () {
    const made = await upload({ serverClockOffsetMs: -250 })
    expect(made.offset).equals(-250)
    expect(made.clockOffset).equals(null)
    expect(made.startAt?.getTime()).equals(gameStart.getTime() - preRollMs)
  })

  it('ignores an offset no clock could have, and takes the upload on its own clock', async function () {
    const warned: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(' '))
    }
    try {
      for (const serverClockOffsetMs of [90_000_000, -90_000_000]) {
        const made = await upload({
          startAt: startedAt.toISOString(),
          serverClockOffsetMs
        })
        expect(made.offset).equals(null)
        expect(made.clockOffset).equals(null)
        expect(made.startAt?.getTime()).equals(startedAt.getTime() - preRollMs)
      }
    } finally {
      console.warn = warn
    }
    expect(warned).has.length(2)
    expect(warned[0]).contains('serverClockOffsetMs 90000000')
    expect(clockOffsetOf(undefined)).equals(null)
    expect(clockOffsetOf(12.6)).equals(13)
    console.warn = () => {}
    try {
      expect(clockOffsetOf(Number.NaN)).equals(null)
      expect(clockOffsetOf(Number.POSITIVE_INFINITY)).equals(null)
      expect(clockOffsetOf(86_400_001)).equals(null)
    } finally {
      console.warn = warn
    }
    expect(clockOffsetOf(-86_400_000)).equals(-86_400_000)
  })
})
