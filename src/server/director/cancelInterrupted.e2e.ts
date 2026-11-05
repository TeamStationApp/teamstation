import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import {
  addGame,
  addPerson,
  addTeam,
  scratchDatabase,
  until
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { startFakeSpace } from '../dev/fakeSpace'
import type { SpaceSettings } from '../media/spacesHls'

/**
 * Giving up an upload that a server restart interrupted, against the real API
 * process.
 *
 *   node src/migrate/requirePostgres18.js && node_modules/.bin/mocha \
 *     --timeout 180000 --exit -r sucrase/register --extension ts \
 *     --spec src/server/director/cancelInterrupted.e2e.ts
 *
 * Needs the Postgres 18 cluster, Redis and `ffmpeg` on PATH. The API runs from
 * a temporary directory holding its own `serverConfig.json`, a scratch
 * database, a fake Space and free ports.
 *
 * A real recording is uploaded and finished. The take-in writes its video on
 * the row and is stopped before it marks the row ready: a trigger holds the
 * ready step, and the API is killed while it waits. Started again, the API
 * reopens the upload, with its video still on it. Giving it up then deletes
 * that video, so the game stops listing it and the Space holds none of it.
 *
 * With `TS_E2E_ARTIFACT_DIR` set it leaves `e2e-cancel-interrupted-server.log`
 * there: each request on a `$` line with its answer, and what the API printed
 * in each of its runs.
 */
const register = require.resolve('sucrase/register')
const API = resolve('src/server/index.ts')

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

/** The API process, with everything it printed. */
interface Api {
  child: ChildProcess
  output: () => string
  exited: Promise<number | null>
  gone: () => boolean
}

function startApi(cwd: string): Api {
  const child = spawn(process.execPath, ['-r', register, API], {
    cwd,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let text = ''
  child.stdout.on('data', chunk => {
    text += String(chunk)
  })
  child.stderr.on('data', chunk => {
    text += String(chunk)
  })
  let gone = false
  const exited = new Promise<number | null>(resolve => {
    child.on('exit', code => {
      gone = true
      resolve(code)
    })
  })
  return { child, output: () => text, exited, gone: () => gone }
}

async function listening(api: Api): Promise<void> {
  await until(
    'the API to listen',
    () => {
      if (api.gone()) throw new Error(`the API exited:\n${api.output()}`)
      return api.output().includes('listening on')
    },
    60_000
  )
}

/** Ended, so its V8 counters are written, as `shutdown` exits the process. */
async function stop(api: Api | undefined): Promise<void> {
  if (api == null || api.gone()) return
  api.child.kill('SIGTERM')
  const late = setTimeout(() => api.child.kill('SIGKILL'), 15_000)
  await api.exited
  clearTimeout(late)
}

describe('an upload a restart interrupted, given up', function () {
  this.timeout(180_000)

  let db: Kysely<Database> | undefined
  let drop: (() => Promise<void>) | undefined
  let store: Awaited<ReturnType<typeof startFakeSpace>> | undefined
  let folder = ''
  let base = ''
  let token = ''
  let gameId = ''
  let config: Record<string, unknown> = {}
  const runs: Api[] = []
  const transcript: string[] = []

  const space: SpaceSettings = {
    bucket: 'test',
    region: 'sfo3',
    endpoint: '',
    accessKeyId: 'k',
    secretAccessKey: 's',
    pathStyle: true
  }

  /** A request to the API, written to the transcript with its answer. */
  async function ask(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json'
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': contentType
      },
      body:
        body == null
          ? undefined
          : body instanceof Buffer
            ? body
            : JSON.stringify(body)
    })
    const text = await response.text()
    const shown =
      body == null
        ? ''
        : body instanceof Buffer
          ? ` (${body.length} bytes)`
          : ` ${JSON.stringify(body)}`
    transcript.push(
      `$ curl -X ${method} ${base}${path}${shown}`,
      `${response.status} ${text}`,
      ''
    )
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text)
    }
  }

  /** The API, as one process. */
  async function run(): Promise<Api> {
    await writeFile(
      join(folder, 'serverConfig.json'),
      JSON.stringify({ ...config, clusterWorkers: 1 })
    )
    transcript.push(
      `$ node -r sucrase/register ${API}   # run ${runs.length + 1}, from the temporary folder`,
      ''
    )
    const api = startApi(folder)
    runs.push(api)
    return api
  }

  /** The video's objects in the fake Space: its files, not its folders. */
  const spaceHolds = async (videoId: string): Promise<string[]> => {
    const dir = join(folder, 'space', 'videos', videoId)
    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true
    }).catch(() => [])
    return entries
      .filter(entry => entry.isFile() && !entry.name.endsWith('.content-type'))
      .map(entry => join(entry.parentPath, entry.name).slice(dir.length + 1))
  }

  /** The parts of an upload on the server's disk. */
  const partsOf = async (uploadId: string): Promise<string[] | null> =>
    await readdir(join(folder, 'media', 'uploads', uploadId)).catch(() => null)

  const listed = async (): Promise<string[]> => {
    const game = await ask('GET', `/games/${gameId}`)
    expect(game.status).equals(200)
    return (game.body.videos as Array<{ id: string }>).map(video => video.id)
  }

  const sleeping = async (): Promise<number> =>
    Number(
      (
        await sql<{ count: string }>`
          select count(*) as count from pg_stat_activity
          where datname = current_database() and wait_event = 'PgSleep'`.execute(
          db!
        )
      ).rows[0].count
    )

  before(async function () {
    const made = await scratchDatabase('cancelupload')
    db = made.db
    drop = made.drop
    folder = await mkdtemp(join(tmpdir(), 'tsCancelInterrupted-'))
    store = await startFakeSpace({ space, dir: join(folder, 'space') })
    space.endpoint = store.url

    const home = await addTeam(db, 'Demo Home')
    const away = await addTeam(db, 'Demo Away')
    gameId = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date()
    })
    const filmer = await addPerson(db, 'filmer')
    token = filmer.token
    await db
      .insertInto('scope_roles')
      .values({
        id: 'rol_cancel_filmer',
        user_id: filmer.userId,
        scope_type: 'team',
        scope_id: home,
        role: 'videographer'
      })
      .execute()

    const port = await freePort()
    base = `http://127.0.0.1:${port}/api/v1`
    await mkdir(join(folder, 'work'), { recursive: true })
    await mkdir(join(folder, 'media'), { recursive: true })
    config = {
      databaseUrl: made.url,
      listenHost: '127.0.0.1',
      listenPort: port,
      statsBuilder: false,
      workDir: join(folder, 'work'),
      mediaDir: join(folder, 'media'),
      ffmpegPath: 'ffmpeg',
      sessionSecret: 's'.repeat(32),
      mediaSecret: 'm'.repeat(32),
      serveMediaLocally: true,
      logRequests: false,
      space,
      live: {
        enabled: false,
        bindHost: '127.0.0.1',
        port: await freePort(),
        healthPort: 0,
        freeDiskFloorGb: 0
      }
    }

    // A real recording, two seconds of picture and sound.
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(folder, 'take.mp4')
    ])
  })

  after(async function () {
    for (const api of runs) await stop(api)
    const out = process.env.TS_E2E_ARTIFACT_DIR
    if (out != null && out !== '') {
      const printed = runs.map(
        (api, index) =>
          `--- what the API printed, run ${index + 1}\n${api.output()}`
      )
      await mkdir(out, { recursive: true })
      await writeFile(
        join(out, 'e2e-cancel-interrupted-server.log'),
        [...transcript, ...printed].join('\n')
      )
    }
    if (store != null) {
      await new Promise<void>(resolve =>
        store!.server.close(() => {
          resolve()
        })
      )
    }
    await drop?.()
    if (folder !== '') await rm(folder, { recursive: true, force: true })
  })

  /**
   * An upload whose take-in wrote its video and was killed before `ready`,
   * and the server started again. Answers the upload and its video, with the
   * restarted API.
   */
  async function interrupted(): Promise<{
    id: string
    videoId: string
    api: Api
  }> {
    const bytes = await readFile(join(folder, 'take.mp4'))
    // The ready step waits here, so the take-in stops between its two
    // writes: the video on the row, and then `ready`.
    await sql
      .raw(
        `create or replace function hold_ready() returns trigger
         language plpgsql as
         $$ begin perform pg_sleep(600); return new; end $$;
         drop trigger if exists hold_ready on director_uploads;
         create trigger hold_ready before update on director_uploads
         for each row when (old.state = 'assembling' and new.state = 'ready')
         execute function hold_ready();`
      )
      .execute(db!)

    let id = ''
    const row = async (): Promise<{
      state: string
      video_id: string | null
    }> =>
      await db!
        .selectFrom('director_uploads')
        .select(['state', 'video_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    const first = await run()
    try {
      await listening(first)
      const opened = await ask('POST', '/director/uploads', {
        gameId,
        title: 'Demo Away at Demo Home',
        filename: 'take.mp4',
        sizeBytes: bytes.length
      })
      expect(opened.status).equals(201)
      id = String(opened.body.uploadId)
      const partSize = Number(opened.body.partSize)
      for (let part = 0; part * partSize < bytes.length; part += 1) {
        const sent = await ask(
          'PUT',
          `/director/uploads/${id}/parts/${part}`,
          bytes.subarray(part * partSize, (part + 1) * partSize),
          'application/octet-stream'
        )
        expect(sent.status).equals(200)
      }
      const finished = await ask('POST', `/director/uploads/${id}/finish`, {})
      expect(finished.status).equals(202)
      await until(
        'the take-in to reach its ready step',
        async () => (await row()).video_id != null && (await sleeping()) > 0,
        120_000
      )

      // The server stops there. Its held transaction never commits.
      first.child.kill('SIGKILL')
      await first.exited
    } finally {
      // However the above ended, the next case starts with no first server,
      // no held step and no hold.
      await stop(first)
      await sql`
        select pg_terminate_backend(pid) from pg_stat_activity
        where datname = current_database() and wait_event = 'PgSleep'`.execute(
        db!
      )
      await until(
        'the held step to end',
        async () => (await sleeping()) === 0,
        30_000
      )
      await sql
        .raw(
          `drop trigger if exists hold_ready on director_uploads;
           drop function if exists hold_ready();`
        )
        .execute(db!)
    }
    const left = await row()
    expect(left.state).equals('assembling')
    const videoId = String(left.video_id)
    expect(await spaceHolds(videoId)).not.deep.equals([])
    expect(await partsOf(id)).includes('part-000000')
    transcript.push(
      `# killed between the take-in's two writes: ${JSON.stringify(left)}`,
      ''
    )

    // Started again, it puts the upload back where it can be asked for.
    const api = await run()
    await listening(api)
    await until(
      'the interrupted upload to be reopened',
      () => api.output().includes('reopened 1 interrupted upload(s)'),
      30_000
    )
    const reopened = await ask('GET', `/director/uploads/${id}`)
    expect(reopened.body.state).equals('open')
    expect(String(reopened.body.message)).contains('restarted')
    expect(reopened.body.videoId).equals(videoId)
    return { id, videoId, api }
  }

  async function givenUp(id: string, videoId: string): Promise<void> {
    expect(await listed()).includes(videoId)
    // Listing a game cuts its poster behind the answer. Waited for, so the
    // still is not written after the delete below has listed the video's
    // objects: that race belongs to any delete of a just-listed video, not
    // to giving an upload up.
    await until(
      'the poster the listing cuts',
      async () => (await spaceHolds(videoId)).includes(join('stills', '1.jpg')),
      30_000
    )
    expect(await partsOf(id)).includes('part-000000')

    const gaveUp = await ask('DELETE', `/director/uploads/${id}`)
    expect(gaveUp.status).equals(204)

    const after = await ask('GET', `/director/uploads/${id}`)
    expect(after.body.state).equals('abandoned')
    expect(await listed()).not.includes(videoId)
    const videoRow = await db!
      .selectFrom('videos')
      .select('id')
      .where('id', '=', videoId)
      .executeTakeFirst()
    expect(videoRow).equals(undefined)
    expect(await spaceHolds(videoId)).deep.equals([])
    expect(await partsOf(id)).equals(null)
  }

  it('deletes the video it had made, and the game stops listing it', async function () {
    const { id, videoId, api } = await interrupted()
    await givenUp(id, videoId)
    await stop(api)
  })
})
