import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import {
  DEFAULT_SPONSOR_SAMPLE_KEY,
  type SponsorSettings
} from '../../common/nodeSettings'
import { SAMPLE_MAX_BYTES } from '../../common/sponsors/limits'
import type { SampleVideo } from '../../common/sponsors/types'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { syntheticVideo } from '../../test/sponsorMedia'
import { mediaBase } from '../media/spacesHls'
import { forgetScoreboardSettings, sponsorSettings } from '../nodeSettings'
import { nodeSampleVideoRoutes } from './nodeSampleVideo'
import { sponsorRoutes } from './sponsors'

const TOO_LARGE = 'The sample video can be at most 120 MB.'

/** U41: a node administrator replaces the sponsor sample video. */
describe('U41 the node sponsor sample upload', function () {
  this.timeout(180000)
  let f: GroupFixture
  const uploads = mkdtempSync(join(tmpdir(), 'sponsor-sample-uploads-'))
  const DAY = new Date('2026-11-25T18:00:00.000Z')
  // A league with no footage, which 101 administers.
  const bare = 'lea_sample_upload_bare'

  before(async function () {
    f = await groupFixture(undefined, undefined, (app, { db, media }) => {
      app.use(
        '/api/v1',
        nodeSampleVideoRoutes(db, media, {
          uploadsDir: uploads,
          clock: () => DAY
        })
      )
      app.use('/api/v1', sponsorRoutes(db, media, { uploadsDir: uploads }))
    })
    await f.h.db
      .insertInto('leagues')
      .values({ id: bare, name: 'Bare League' })
      .execute()
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: 'rol_sample_upload_bare',
        user_id: userIdOfGumbo(101),
        scope_type: 'league',
        scope_id: bare,
        role: 'admin',
        granted_by: null
      })
      .execute()
  })

  beforeEach(() => {
    forgetScoreboardSettings()
  })

  after(async function () {
    forgetScoreboardSettings()
    await f?.h.close()
    rmSync(uploads, { recursive: true, force: true })
  })

  const put = async (bytes: Uint8Array, user = 105): Promise<Response> =>
    await fetch(`${f.h.origin}/api/v1/node/sponsor-sample`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${f.h.tokens.get(user)!}`,
        'content-type': 'video/mp4'
      },
      body: new Uint8Array(bytes)
    })
  const refusal = async (response: Response): Promise<string> => {
    expect(response.status, await response.clone().text()).equals(400)
    return ((await response.json()) as { message: string }).message
  }
  const sample = async (): Promise<SampleVideo> => {
    const response = await f.h.request(
      'GET',
      `/leagues/${bare}/sponsors/sample`,
      undefined,
      101
    )
    expect(response.status, await response.clone().text()).equals(200)
    return (await response.json()) as SampleVideo
  }
  /** Nothing an upload wrote is left beside the uploads. */
  const leftovers = (): string[] => {
    try {
      return readdirSync(join(uploads, 'sponsors'))
    } catch {
      return []
    }
  }

  /**
   * Streams `total` bytes in 1 MB chunks to the route, with or without a
   * declared length, and answers the response and how many bytes were sent
   * before the server stopped taking them.
   */
  const stream = async (
    total: number,
    declare: boolean
  ): Promise<{ status: number; body: string; sent: number }> =>
    await new Promise((resolve, reject) => {
      const url = new URL(`${f.h.origin}/api/v1/node/sponsor-sample`)
      const chunk = Buffer.alloc(1 << 20, 7)
      let sent = 0
      let answered = false
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'PUT',
          headers: {
            authorization: `Bearer ${f.h.tokens.get(105)!}`,
            'content-type': 'video/mp4',
            ...(declare ? { 'content-length': String(total) } : {})
          }
        },
        res => {
          answered = true
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (part: string) => (body += part))
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body, sent })
          })
          res.on('error', () => {
            resolve({ status: res.statusCode ?? 0, body, sent })
          })
        }
      )
      req.on('error', error => {
        // The server closes the connection once it has refused: an error
        // after the answer is that close.
        if (!answered) reject(error)
      })
      const write = (): void => {
        while (sent < total) {
          if (answered) return
          const part = chunk.subarray(0, Math.min(chunk.length, total - sent))
          sent += part.length
          if (!req.write(part)) {
            req.once('drain', write)
            return
          }
        }
        if (!answered) req.end()
      }
      write()
    })

  it('refuses anybody but a node administrator before reading the body', async function () {
    const clip = await syntheticVideo({
      seconds: 2,
      width: 1920,
      height: 1080,
      fps: 30
    })
    expect((await put(clip, 101)).status).equals(403)
    const signedOut = await fetch(`${f.h.origin}/api/v1/node/sponsor-sample`, {
      method: 'PUT',
      body: new Uint8Array(clip)
    })
    expect(signedOut.status).equals(401)
    expect((await sponsorSettings(f.h.db, Date.now(), true)).sampleKey).equals(
      null
    )
  })

  it('plays the default clip for a league without footage before any upload', async function () {
    expect(await sample()).to.include({
      kind: 'node',
      url: `${mediaBase(f.h.space)}/${DEFAULT_SPONSOR_SAMPLE_KEY}`
    })
  })

  it('refuses a 720p clip, a 61 fps clip, a 121 s clip and a 1080p H.264 clip not in an MP4, each with its sentence', async function () {
    expect(
      await refusal(
        await put(
          await syntheticVideo({
            seconds: 2,
            width: 1280,
            height: 720,
            fps: 30
          })
        )
      )
    ).equals('The sample video must be 1,920 × 1,080.')
    expect(
      await refusal(
        await put(
          await syntheticVideo({
            seconds: 2,
            width: 1920,
            height: 1080,
            fps: 61
          })
        )
      )
    ).equals('The sample video can be at most 60 frames a second.')
    expect(
      await refusal(
        await put(
          await syntheticVideo({
            seconds: 121,
            width: 1920,
            height: 1080,
            fps: 1
          })
        )
      )
    ).equals('The sample video can be at most 2 minutes long.')
    // H.264 at 1080p in Matroska and MPEG-TS probes as the codec asks, but
    // is stored and served as `video/mp4`.
    for (const container of ['mkv', 'ts'] as const)
      expect(
        await refusal(
          await put(
            await syntheticVideo({
              seconds: 2,
              width: 1920,
              height: 1080,
              fps: 30,
              container
            })
          )
        ),
        container
      ).equals('The sample video must be an MP4 file.')
    expect(await refusal(await put(Buffer.from('not a video at all')))).equals(
      'This video could not be read. Try another file.'
    )
    expect(await refusal(await put(new Uint8Array()))).equals(
      'Choose a file to upload.'
    )
    expect((await sponsorSettings(f.h.db, Date.now(), true)).sampleKey).equals(
      null
    )
    expect(leftovers()).deep.equals([])
  })

  it('refuses a body over 120 MB at the cap, declared or not, and keeps none of it', async function () {
    // Up to twice the cap the rest is read and dropped before the refusal,
    // so a proxy in front passes the sentence on: the whole body was sent.
    const total = SAMPLE_MAX_BYTES + 10_000_000
    for (const declare of [true, false]) {
      const near = await stream(total, declare)
      expect(near.status, `declared ${declare}`).equals(400)
      expect(JSON.parse(near.body).message).equals(TOO_LARGE)
      expect(near.sent).equals(total)
    }

    // Declared past twice the cap: refused before a byte is read, and little
    // of it was ever sent.
    const declared = await stream(3 * SAMPLE_MAX_BYTES, true)
    expect(declared.status).equals(400)
    expect(JSON.parse(declared.body).message).equals(TOO_LARGE)
    expect(declared.sent).lessThan(SAMPLE_MAX_BYTES / 2)

    // Undeclared and longer: dropped to twice the cap, then cut off. What
    // was sent past it is only what the connection's buffers took.
    const undeclared = await stream(400_000_000, false)
    expect(undeclared.status).equals(400)
    expect(JSON.parse(undeclared.body).message).equals(TOO_LARGE)
    expect(undeclared.sent).greaterThan(2 * SAMPLE_MAX_BYTES)
    expect(undeclared.sent).lessThan(2 * SAMPLE_MAX_BYTES + 60_000_000)
    expect(leftovers()).deep.equals([])
    expect((await sponsorSettings(f.h.db, Date.now(), true)).sampleKey).equals(
      null
    )
  })

  it('stores a 1920 × 1080 30 fps 10 s H.264 clip, makes it the node’s sample, and plays it for a league without footage', async function () {
    const clip = await syntheticVideo({
      seconds: 10,
      width: 1920,
      height: 1080,
      fps: 30
    })
    const response = await put(clip)
    expect(response.status, await response.clone().text()).equals(200)
    const settings = (await response.json()) as SponsorSettings
    expect(settings.sampleKey).matches(
      /^sponsors\/sample\/2026-11-25-smd_[A-Za-z0-9_-]+\.mp4$/
    )
    const stored = f.h.objects.get(`/${f.h.space.bucket}/${settings.sampleKey}`)
    expect(stored?.equals(clip)).equals(true)
    const row = await f.h.db
      .selectFrom('system_settings')
      .select(['value', 'updated_by'])
      .where('key', '=', 'sponsors.sampleKey')
      .executeTakeFirstOrThrow()
    expect(row).deep.equals({
      value: settings.sampleKey,
      updated_by: userIdOfGumbo(105)
    })
    expect(await sample()).to.include({
      kind: 'node',
      url: `${mediaBase(f.h.space)}/${settings.sampleKey}`
    })
    const read = await f.h.request('GET', '/node/settings', undefined, 105)
    expect(
      ((await read.json()) as { sponsors: SponsorSettings }).sponsors.sampleKey
    ).equals(settings.sampleKey)
    expect(leftovers()).deep.equals([])
  })

  it('deletes the uploaded clip a new upload replaces, and the last one on Reset to defaults, never the default clip', async function () {
    const object = (key: string | null): Buffer | undefined =>
      f.h.objects.get(`/${f.h.space.bucket}/${key}`)
    const defaultClip = `/${f.h.space.bucket}/${DEFAULT_SPONSOR_SAMPLE_KEY}`
    f.h.objects.set(defaultClip, Buffer.from('the default clip'))
    const uploaded = async (seconds: number): Promise<string | null> => {
      const response = await put(
        await syntheticVideo({ seconds, width: 1920, height: 1080, fps: 30 })
      )
      expect(response.status, await response.clone().text()).equals(200)
      return ((await response.json()) as SponsorSettings).sampleKey
    }
    const first = await uploaded(3)
    const second = await uploaded(4)
    expect(second).not.equals(first)
    expect(object(first)).equals(undefined)
    expect(object(second)).not.equals(undefined)
    // Reset to defaults then Save.
    const read = (await (
      await f.h.request('GET', '/node/settings', undefined, 105)
    ).json()) as { sponsors: SponsorSettings }
    const reset = await f.h.request(
      'PUT',
      '/node/settings',
      { ...read, sponsors: { ...read.sponsors, sampleKey: null } },
      105
    )
    expect(reset.status, await reset.clone().text()).equals(200)
    expect(
      ((await reset.json()) as { sponsors: SponsorSettings }).sponsors.sampleKey
    ).equals(null)
    expect(object(second)).equals(undefined)
    // A second reset, the default clip in place, deletes nothing.
    expect(
      (
        await f.h.request(
          'PUT',
          '/node/settings',
          { ...read, sponsors: { ...read.sponsors, sampleKey: null } },
          105
        )
      ).status
    ).equals(200)
    expect(f.h.objects.get(defaultClip)?.toString()).equals('the default clip')
  })
})
