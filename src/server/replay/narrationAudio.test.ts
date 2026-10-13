import { expect } from 'chai'
import express from 'express'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asGameDetail } from '../../common/api'
import type { HttpError } from '../../common/errors'
import { asUserId } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { REPLAY_SEED, type ReplaySeed, seedReplay } from '../dev/replaySeed'
import type { MediaContext } from '../media/mediaContext'
import { errorHandler } from '../middleware/withErrors'
import { narrationRoutes } from '../routes/narrations'
import { teamRoutes } from '../routes/teams'
import {
  forgetNarrations,
  narrationFor,
  narrationsFor,
  sentenceDigest
} from './narrationAudio'
import { hasRecordedPlays } from './replayable'
import { type SpeechSettings, SpeechUnavailable } from './speech'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_narration_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const settings: SpeechSettings = {
  apiKey: 'xai-test-key',
  baseUrl: 'https://speech.example.test/v1',
  voice: 'rex',
  speed: 1.1,
  bitRate: 64000
}

const media: MediaContext = {
  ffmpegPath: 'ffmpeg',
  mediaRoot: '/tmp',
  mediaSecret: 'secret',
  publicUrl: 'http://127.0.0.1',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: false
  }
}

/** A speech service in memory: every sentence spoken, and a switch to fail. */
class FakeSpeech {
  spoken: string[] = []
  failing = false
  fetch: typeof fetch = async (
    _url: string | URL | Request,
    init?: RequestInit
  ) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    if (this.failing) return new Response('down', { status: 503 })
    this.spoken.push(JSON.parse(init?.body as string).text)
    return new Response(new Uint8Array([0xff, 0xf3, this.spoken.length]))
  }
}

describe('replay narration audio', function () {
  this.timeout(120000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  let seeded: ReplaySeed
  const speech = new FakeSpeech()
  let base = ''
  let offBase = ''
  let server: ReturnType<express.Express['listen']> | undefined
  let offServer: ReturnType<express.Express['listen']> | undefined

  function app(spoken: SpeechSettings | null): express.Express {
    const made = express()
    made.use((req, _res, next) => {
      const id = req.header('x-test-actor')
      if (id != null)
        req.actor = { userId: asUserId(id), isAdmin: false, scopes: [] }
      next()
    })
    made.use('/api/v1', narrationRoutes(db!, spoken, speech.fetch))
    made.use('/api/v1', teamRoutes(db!, media))
    made.use(errorHandler)
    return made
  }

  function listen(made: express.Express): {
    server: ReturnType<express.Express['listen']>
    base: string
  } {
    const listening = made.listen(0)
    const address = listening.address()
    return {
      server: listening,
      base:
        typeof address === 'object' && address != null
          ? `http://127.0.0.1:${address.port}/api/v1`
          : ''
    }
  }

  before(async function () {
    attachInt8Parser()
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
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    seeded = await seedReplay(db, { password: 'replay-test-password' })
    ;({ server, base } = listen(app(settings)))
    ;({ server: offServer, base: offBase } = listen(app(null)))
  })

  after(async function () {
    server?.close()
    offServer?.close()
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  async function kept(): Promise<number> {
    const row = await db!
      .selectFrom('narration_audio')
      .select(eb => eb.fn.countAll().as('n'))
      .executeTakeFirstOrThrow()
    return Number(row.n)
  }

  it('speaks a sentence once and serves it to every game that says it', async function () {
    const first = await narrationFor(
      db!,
      REPLAY_SEED.games.final,
      '0-0',
      settings,
      speech.fetch
    )
    expect(first.text).equals('Juan S steps in. Ball one, one and oh.')
    expect(speech.spoken).deep.equals([first.text])
    expect(await kept()).equals(1)
    // The game in progress opens the same way: no second request.
    const again = await narrationFor(
      db!,
      REPLAY_SEED.games.inProgress,
      '0-0',
      settings,
      speech.fetch
    )
    expect(again.digest).equals(first.digest)
    expect([...again.audio]).deep.equals([...first.audio])
    expect(speech.spoken).length(1)
    expect(first.digest).equals(
      sentenceDigest({ text: first.text, emphasis: 'calm' }, settings)
    )
  })

  it('makes one request for two asks at once', async function () {
    const before = speech.spoken.length
    const [a, b] = await Promise.all([
      narrationFor(db!, REPLAY_SEED.games.final, '0-1', settings, speech.fetch),
      narrationFor(db!, REPLAY_SEED.games.final, '0-1', settings, speech.fetch)
    ])
    expect(a.digest).equals(b.digest)
    expect(speech.spoken.length).equals(before + 1)
  })

  it('keeps nothing when speech fails, and refuses steps it does not have', async function () {
    const rows = await kept()
    speech.failing = true
    let error: unknown
    try {
      await narrationFor(
        db!,
        REPLAY_SEED.games.final,
        '0-2',
        settings,
        speech.fetch
      )
    } catch (caught) {
      error = caught
    }
    speech.failing = false
    expect(error).instanceOf(SpeechUnavailable)
    expect(await kept()).equals(rows)
    for (const step of ['99-0', '0-99'])
      try {
        await narrationFor(
          db!,
          REPLAY_SEED.games.final,
          step,
          settings,
          speech.fetch
        )
        expect.fail('no such step')
      } catch (caught) {
        expect((caught as HttpError).status).equals(404)
      }
    try {
      await narrationFor(db!, 'gam_noSuchGame', '0-0', settings, speech.fetch)
      expect.fail('no such game')
    } catch (caught) {
      expect((caught as HttpError).status).equals(404)
    }
    // A game nothing was scored in has no steps.
    expect(await narrationsFor(db!, REPLAY_SEED.games.imported)).deep.equals(
      new Map()
    )
  })

  it('reads the game afresh when what is stored changes', async function () {
    forgetNarrations()
    const live = await narrationsFor(db!, REPLAY_SEED.games.inProgress)
    // Nothing changed: the sentences already written.
    expect(await narrationsFor(db!, REPLAY_SEED.games.inProgress)).equals(live)
    // A play rewritten in place, its update time untouched, is a new version.
    const first = await db!
      .selectFrom('events')
      .select(['id', 'gumbo'])
      .where('gameId', '=', REPLAY_SEED.games.inProgress)
      .orderBy('atBatIndex')
      .executeTakeFirstOrThrow()
    await sql`update events set gumbo = jsonb_set(gumbo, '{rewritten}', 'true') where id = ${first.id}`.execute(
      db!
    )
    const rewritten = await narrationsFor(db!, REPLAY_SEED.games.inProgress)
    expect(rewritten).not.equals(live)
    expect(rewritten).deep.equals(live)
    await db!
      .updateTable('events')
      .set({ gumbo: JSON.stringify(first.gumbo) })
      .where('id', '=', first.id)
      .execute()
    const original = await db!
      .selectFrom('games')
      .select('currentPlay')
      .where('id', '=', REPLAY_SEED.games.inProgress)
      .executeTakeFirstOrThrow()
    await db!
      .updateTable('games')
      .set({ currentPlay: null })
      .where('id', '=', REPLAY_SEED.games.inProgress)
      .execute()
    const shorter = await narrationsFor(db!, REPLAY_SEED.games.inProgress)
    expect(shorter.size).lessThan(live.size)
    await db!
      .updateTable('games')
      .set({ currentPlay: JSON.stringify(original.currentPlay) })
      .where('id', '=', REPLAY_SEED.games.inProgress)
      .execute()
    expect(
      (await narrationsFor(db!, REPLAY_SEED.games.inProgress)).size
    ).equals(live.size)
  })

  it('reads a step as it stood with the count asked, the sentence its viewer was shown', async function () {
    // Every sentence this speaks is forgotten after, as if never asked for.
    const had = (
      await db!.selectFrom('narration_audio').select('digest').execute()
    ).map(row => row.digest)
    try {
      await readAsItStood()
    } finally {
      let forget = db!.deleteFrom('narration_audio')
      if (had.length > 0) forget = forget.where('digest', 'not in', had)
      await forget.execute()
    }
  })

  async function readAsItStood(): Promise<void> {
    const narrations = await narrationsFor(db!, REPLAY_SEED.games.final)
    let grown: { key: string; first: string; full: string } | undefined
    for (const key of narrations.keys()) {
      const full = await narrationFor(
        db!,
        REPLAY_SEED.games.final,
        key,
        settings,
        speech.fetch
      )
      const first = await narrationFor(
        db!,
        REPLAY_SEED.games.final,
        key,
        settings,
        speech.fetch,
        1
      )
      if (first.text !== full.text && first.text !== '') {
        grown = { key, first: first.text, full: full.text }
        break
      }
    }
    // A ball put in play is first just that; the scorer then adds its result.
    expect(grown, 'a step that grew').not.equals(undefined)
    expect(grown!.full).equals(narrations.get(grown!.key)!.text)
    const again = await narrationFor(
      db!,
      REPLAY_SEED.games.final,
      grown!.key,
      settings,
      speech.fetch,
      1
    )
    expect(again.text).equals(grown!.first)
    // A count at or past the step's own is the step as it stands.
    const past = await narrationFor(
      db!,
      REPLAY_SEED.games.final,
      grown!.key,
      settings,
      speech.fetch,
      999
    )
    expect(past.text).equals(grown!.full)
    const path = `/games/${REPLAY_SEED.games.final}/narrations/${grown!.key}`
    const actor = { 'x-test-actor': String(seeded.accounts.team) }
    const [whole, earlier] = await Promise.all([
      fetch(`${base}${path}`, { headers: actor }),
      fetch(`${base}${path}?count=1`, { headers: actor })
    ])
    expect([whole.status, earlier.status]).deep.equals([200, 200])
    expect(earlier.headers.get('etag')).not.equals(whole.headers.get('etag'))
    for (const bad of ['0', '1.5', 'many'])
      expect(
        (await fetch(`${base}${path}?count=${bad}`, { headers: actor })).status,
        bad
      ).equals(400)
  }

  it('names a renamed team anew', async function () {
    const end = async (): Promise<string> =>
      (await narrationsFor(db!, REPLAY_SEED.games.final)).get('9999-1')!.text
    expect(await end()).includes('Valley Pines')
    const rename = async (name: string): Promise<void> => {
      await db!
        .updateTable('teams')
        .set({ name })
        .where('id', '=', 'tem_replayPines')
        .execute()
    }
    await rename('Lakeside Pines')
    try {
      expect(await end()).includes('Lakeside Pines')
    } finally {
      await rename('Valley Pines')
    }
    expect(await end()).includes('Valley Pines')
  })

  describe('the route', function () {
    const get = async (
      at: string,
      path: string,
      actor?: string,
      headers: Record<string, string> = {}
    ): Promise<Response> =>
      await fetch(`${at}${path}`, {
        headers: {
          ...headers,
          ...(actor == null ? {} : { 'x-test-actor': String(actor) })
        }
      })

    it('answers each member the sentence as MP3, and 304 for one they hold', async function () {
      const path = `/games/${REPLAY_SEED.games.final}/narrations/0-0`
      let etag = ''
      for (const key of ['team', 'season', 'league'] as const) {
        const res = await get(base, path, seeded.accounts[key])
        expect(res.status, key).equals(200)
        expect(res.headers.get('content-type')).match(/^audio\/mpeg/)
        expect(res.headers.get('cache-control')).equals('private, no-cache')
        etag = res.headers.get('etag')!
        expect(
          [...new Uint8Array(await res.arrayBuffer())].slice(0, 2)
        ).deep.equals([0xff, 0xf3])
      }
      const held = await get(base, path, seeded.accounts.team, {
        'If-None-Match': etag
      })
      expect(held.status).equals(304)
    })

    it('refuses the signed-out, outsiders, unknown steps, and answers 503 without speech', async function () {
      const path = `/games/${REPLAY_SEED.games.final}/narrations/0-0`
      expect((await get(base, path)).status).equals(401)
      expect((await get(base, path, seeded.accounts.outsider)).status).equals(
        404
      )
      expect(
        (
          await get(
            base,
            `/games/${REPLAY_SEED.games.final}/narrations/99-0`,
            seeded.accounts.team
          )
        ).status
      ).equals(404)
      const off = await get(offBase, path, seeded.accounts.team)
      expect(off.status).equals(503)
      expect(await off.json()).deep.equals({ error: 'narrationUnavailable' })
      speech.failing = true
      const failed = await get(
        base,
        `/games/${REPLAY_SEED.games.final}/narrations/0-3`,
        seeded.accounts.team
      )
      speech.failing = false
      expect(failed.status).equals(503)
    })

    it('says which games replay on the game itself', async function () {
      const replayable = async (gameId: string): Promise<boolean> =>
        asGameDetail(
          await (
            await get(base, `/games/${gameId}`, seeded.accounts.team)
          ).json()
        ).replayable
      expect(await replayable(REPLAY_SEED.games.final)).equals(true)
      expect(await replayable(REPLAY_SEED.games.importedThenScored)).equals(
        true
      )
      expect(await replayable(REPLAY_SEED.games.imported)).equals(false)
      expect(
        await hasRecordedPlays(db!, REPLAY_SEED.games.imported, {
          teamStation: {}
        })
      ).equals(true)
    })
  })
})
