import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'

import { type LiveFixture, liveFixture } from '../../test/liveFixture'
import { asServerConfig, type LiveSettings } from '../serverConfig'
import {
  drainLiveController,
  liveTimersRunningForTest,
  liveVideoDir,
  queueLiveWorkForTest,
  startLiveController,
  stopLiveController
} from './controller'

/**
 * The controller's start: nothing in the database or on the disk is touched
 * until this process holds the RTMP port.
 */
const SECRET = 's'.repeat(32)

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  await new Promise<void>(resolve =>
    probe.close(() => {
      resolve()
    })
  )
  if (address == null || typeof address !== 'object') throw new Error('no port')
  return address.port
}

async function accepts(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = new Socket()
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      resolve(false)
    })
    socket.connect(port, '127.0.0.1')
  })
}

describe('starting the live controller', function () {
  this.timeout(60000)
  let fixture: LiveFixture | undefined
  let mediaRoot = ''
  let holder: Server | undefined
  const lines: string[] = []

  before(async function () {
    fixture = await liveFixture('startcontroller')
    if (fixture == null) this.skip()
    mediaRoot = await mkdtemp(join(tmpdir(), 'tsStartController-'))
  })

  afterEach(async function () {
    stopLiveController()
    if (holder != null) {
      const closing = holder
      holder = undefined
      await new Promise<void>(resolve =>
        closing.close(() => {
          resolve()
        })
      )
    }
  })

  after(async function () {
    await fixture?.drop()
    if (mediaRoot !== '') await rm(mediaRoot, { recursive: true, force: true })
  })

  function settings(port: number): LiveSettings {
    return { ...asServerConfig({}).live, bindHost: '127.0.0.1', port }
  }

  async function start(
    live: LiveSettings,
    bindTimeoutMs = 5000
  ): Promise<boolean> {
    lines.length = 0
    return await startLiveController(
      {
        db: fixture!.db,
        live,
        ffmpegPath: '/does/not/matter',
        mediaRoot,
        workDir: mediaRoot,
        sessionSecret: SECRET,
        log: line => lines.push(line),
        freeBytes: async () => Number.MAX_SAFE_INTEGER
      },
      bindTimeoutMs
    )
  }

  it('drains work that the work it waits on queues', async function () {
    const done: string[] = []
    queueLiveWorkForTest('first', async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      done.push('first')
      queueLiveWorkForTest('finish:later', async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        done.push('later')
      })
    })
    await drainLiveController()
    expect(done).deep.equals(['first', 'later'])
  })

  it('touches nothing when somebody else holds the port', async function () {
    const port = await freePort()
    holder = createServer()
    await new Promise<void>(resolve =>
      holder!.listen(port, '127.0.0.1', resolve)
    )
    const live = settings(port)
    const stream = await fixture!.addStream(live, SECRET, 'publishing')
    // A local copy that is safely away and past its grace: what a sweep
    // deletes.
    await fixture!.db
      .updateTable('videos')
      .set({
        storage: 'spaces',
        spaces_verified_at: new Date(0),
        local_delete_after: new Date(0)
      })
      .where('id', '=', stream.videoId)
      .execute()
    const dir = liveVideoDir(mediaRoot, stream.videoId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'seg000000.m4s'), 'still here')
    const before = await fixture!.db
      .selectFrom('videos')
      .selectAll()
      .where('id', '=', stream.videoId)
      .executeTakeFirstOrThrow()

    expect(await start(live)).equals(false)
    expect(lines).includes(`live ingest did not bind 127.0.0.1:${port}`)
    expect(liveTimersRunningForTest()).equals(false)
    // Give a sweep that should not have started the time to have run.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await fixture!.stateOf(stream.id)).equals('publishing')
    expect(await readdir(dir)).deep.equals(['seg000000.m4s'])
    expect(
      await fixture!.db
        .selectFrom('videos')
        .selectAll()
        .where('id', '=', stream.videoId)
        .executeTakeFirstOrThrow()
    ).deep.equals(before)

    await fixture!.db
      .updateTable('live_streams')
      .set({ state: 'idle' })
      .where('id', '=', stream.id)
      .execute()
  })

  it('resets leftover publishing rows and starts its timers once it holds the port', async function () {
    const port = await freePort()
    const live = settings(port)
    const publishing = await fixture!.addStream(live, SECRET, 'publishing')
    const idle = await fixture!.addStream(live, SECRET, 'idle')
    // A publisher that connected the moment the port opened: its publish is
    // newer than the start, and the row is its own.
    const fresh = await fixture!.addStream(live, SECRET, 'publishing')
    await fixture!.db
      .updateTable('live_streams')
      .set({ last_published_at: new Date(Date.now() + 60_000) })
      .where('id', '=', fresh.id)
      .execute()
    // A leftover the API touched since — a rename, an end — is still a
    // leftover: its publish is older.
    const touched = await fixture!.addStream(live, SECRET, 'publishing')
    await fixture!.db
      .updateTable('live_streams')
      .set({
        last_published_at: new Date(Date.now() - 60_000),
        updated_at: new Date(Date.now() + 60_000)
      })
      .where('id', '=', touched.id)
      .execute()
    const updatedAt = async (id: string): Promise<Date> =>
      (
        await fixture!.db
          .selectFrom('live_streams')
          .select('updated_at')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).updated_at
    const idleBefore = await updatedAt(idle.id)
    const publishingBefore = await updatedAt(publishing.id)

    expect(await start(live)).equals(true)
    expect(liveTimersRunningForTest()).equals(true)
    expect(await accepts(port)).equals(true)
    expect(await fixture!.stateOf(publishing.id)).equals('idle')
    expect(await fixture!.stateOf(idle.id)).equals('idle')
    expect(await fixture!.stateOf(fresh.id)).equals('publishing')
    expect(await fixture!.stateOf(touched.id)).equals('idle')
    expect((await updatedAt(publishing.id)).getTime()).greaterThan(
      publishingBefore.getTime()
    )
    expect((await updatedAt(idle.id)).getTime()).equals(idleBefore.getTime())

    stopLiveController()
    expect(liveTimersRunningForTest()).equals(false)
    expect(await accepts(port)).equals(false)
  })
})
