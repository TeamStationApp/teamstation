import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import type { SponsorState } from '../../common/sponsors/types'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { jpegBytes, pngBytes, syntheticVideo } from '../../test/sponsorMedia'
import type { Database } from '../db/database'
import { mediaBase } from '../media/spacesHls'
import type { ScoreboardStore } from '../scoreboard/scoreboardStore'
import { sweepSponsorMedia, UNUSED_MEDIA_MS } from '../sponsors/media'
import { startSponsorSweeps } from '../sponsors/sweeps'
import { sponsorRoutes } from './sponsors'

const HOUR = 60 * 60 * 1000

/** U5: the league-admin sponsor API on a real database and object store. */
describe('U5 the sponsor routes', function () {
  this.timeout(120000)
  let f: GroupFixture
  let now = Date.now()
  const uploads = mkdtempSync(join(tmpdir(), 'sponsor-uploads-'))
  // A league inserted straight into `leagues`, as the fixtures do: no
  // credits row until something reads it.
  const bare = 'lea_sponsor_bare'

  before(async function () {
    f = await groupFixture(undefined, undefined, (app, { db, media }) => {
      app.use(
        '/api/v1',
        sponsorRoutes(db, media, {
          uploadsDir: uploads,
          clock: () => new Date(now)
        })
      )
    })
    await f.h.db
      .insertInto('leagues')
      .values({ id: bare, name: 'Bare League' })
      .execute()
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: 'rol_sponsor_bare',
        user_id: userIdOfGumbo(101),
        scope_type: 'league',
        scope_id: bare,
        role: 'admin',
        granted_by: null
      })
      .execute()
  })

  after(async function () {
    await f?.h.close()
    rmSync(uploads, { recursive: true, force: true })
  })

  /** A raw upload, as the client sends one. */
  const upload = async (
    leagueId: string,
    purpose: string,
    bytes: Uint8Array,
    user = 101
  ): Promise<Response> =>
    await fetch(
      `${f.h.origin}/api/v1/leagues/${leagueId}/sponsors/media?purpose=${purpose}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.h.tokens.get(user)!}`,
          'content-type': 'application/octet-stream'
        },
        body: new Uint8Array(bytes)
      }
    )
  const error = async (response: Response): Promise<string> =>
    ((await response.json()) as { message: string }).message
  const mediaId = async (
    leagueId: string,
    purpose: string,
    bytes: Uint8Array
  ): Promise<string> => {
    const response = await upload(
      leagueId,
      purpose,
      bytes,
      leagueId === f.leagueB ? 102 : 101
    )
    expect(response.status, await response.clone().text()).equals(201)
    return ((await response.json()) as { mediaId: string }).mediaId
  }
  const stateOf = async (response: Response): Promise<SponsorState> => {
    expect(response.status, await response.clone().text()).within(200, 201)
    return (await response.json()) as SponsorState
  }
  const read = async (leagueId: string): Promise<SponsorState> =>
    await stateOf(
      await f.h.request(
        'GET',
        `/leagues/${leagueId}/sponsors`,
        undefined,
        leagueId === f.leagueB ? 102 : 101
      )
    )

  let reel12: Buffer
  before(async function () {
    reel12 = await syntheticVideo({
      seconds: 12,
      width: 640,
      height: 360,
      fps: 30
    })
  })

  describe('access', function () {
    it('refuses a non-admin every route with 403, and a missing league with 404', async function () {
      const logo = await mediaId(f.leagueA, 'logo', pngBytes(100, 100))
      const added = await read(f.leagueA)
      expect(added.logos).deep.equals([])
      const listed = await stateOf(
        await f.h.request('POST', `/leagues/${f.leagueA}/sponsors/logos`, {
          mediaId: logo,
          name: 'Access',
          allocation: 1
        })
      )
      const logoId = listed.logos[0].id
      const requests: Array<[string, string, unknown?]> = [
        ['GET', `/leagues/${f.leagueA}/sponsors`],
        ['GET', `/leagues/${f.leagueA}/sponsors/sample`],
        ['POST', `/leagues/${f.leagueA}/sponsors/logos`, {}],
        ['POST', `/leagues/${f.leagueA}/sponsors/reels`, {}],
        ['POST', `/leagues/${f.leagueA}/sponsors/rows`, {}],
        ['PATCH', `/sponsors/logos/${logoId}`, { allocation: 2 }],
        ['POST', `/sponsors/logos/${logoId}/deactivate`]
      ]
      for (const [method, path, body] of requests)
        expect(
          (await f.h.request(method, path, body, 103)).status,
          `${method} ${path}`
        ).equals(403)
      expect(
        (await upload(f.leagueA, 'logo', pngBytes(10, 10), 103)).status
      ).equals(403)
      expect(
        (await f.h.request('GET', '/leagues/lea_missing/sponsors')).status
      ).equals(404)
      expect(
        (await upload('lea_missing', 'logo', pngBytes(10, 10))).status
      ).equals(404)
      expect(
        (
          await f.h.request('PATCH', '/sponsors/logos/slg_missing', {
            allocation: 1
          })
        ).status
      ).equals(404)
      expect(
        (await f.h.request('DELETE', '/sponsors/rows/ser_missing')).status
      ).equals(404)
      expect(
        (
          await f.h.request(
            'GET',
            `/leagues/${f.leagueA}/sponsors`,
            undefined,
            null
          )
        ).status
      ).equals(401)
      await stateOf(
        await f.h.request('POST', `/sponsors/logos/${logoId}/deactivate`)
      )
    })
  })

  describe('uploads', function () {
    it('stores a 480 × 270 PNG logo at sponsors/<league>/<media>.png, public', async function () {
      const response = await upload(f.leagueA, 'logo', pngBytes(480, 270))
      expect(response.status).equals(201)
      const body = (await response.json()) as {
        mediaId: string
        url: string
        width: number
        height: number
        durationMs: number | null
      }
      expect(body.mediaId).matches(/^smd_/)
      const key = `sponsors/${f.leagueA}/${body.mediaId}.png`
      expect(body).deep.equals({
        mediaId: body.mediaId,
        url: `${mediaBase(f.h.space)}/${key}`,
        width: 480,
        height: 270,
        durationMs: null
      })
      expect(f.h.objects.get(`/${f.h.space.bucket}/${key}`)).deep.equals(
        pngBytes(480, 270)
      )
      const row = await f.h.db
        .selectFrom('sponsor_media')
        .select([
          'purpose',
          'object_key',
          'content_type',
          'bytes',
          'created_by'
        ])
        .where('id', '=', body.mediaId)
        .executeTakeFirstOrThrow()
      expect(row).deep.equals({
        purpose: 'logo',
        object_key: key,
        content_type: 'image/png',
        bytes: pngBytes(480, 270).length,
        created_by: userIdOfGumbo(101)
      })
    })

    it('refuses a 481 × 270 PNG and a JPEG logo with their sentences', async function () {
      const wide = await upload(f.leagueA, 'logo', pngBytes(481, 270))
      expect(wide.status).equals(400)
      expect(await error(wide)).equals('Logos can be at most 480 × 270 pixels.')
      const jpeg = await upload(f.leagueA, 'logo', jpegBytes(300, 200))
      expect(jpeg.status).equals(400)
      expect(await error(jpeg)).equals('Logos must be PNG files.')
    })

    it('refuses a 3,200,001-byte reel before ffprobe, and a larger body unread', async function () {
      // Not a video at all: had it reached ffprobe, it would say so.
      const over = await upload(f.leagueA, 'reel', Buffer.alloc(3_200_001, 1))
      expect(over.status).equals(400)
      expect(await error(over)).equals('Reels can be at most 3.2 MB.')
      const far = await upload(f.leagueA, 'reel', Buffer.alloc(6_000_000, 1))
      expect(far.status).equals(400)
      expect(await error(far)).equals('Reels can be at most 3.2 MB.')
      const notMp4 = await upload(f.leagueA, 'reel', Buffer.alloc(1000, 1))
      expect(await error(notMp4)).equals('Reels must be H.264 MP4 files.')
    })

    it('takes a 12 s 640 × 360 H.264 reel made with ffmpeg, and refuses 20 s and 60 fps ones', async function () {
      const response = await upload(f.leagueA, 'reel', reel12)
      expect(response.status, await response.clone().text()).equals(201)
      const body = (await response.json()) as {
        mediaId: string
        width: number
        height: number
        durationMs: number
      }
      expect(body).to.include({ width: 640, height: 360 })
      expect(body.durationMs).within(11_900, 12_100)
      expect(
        f.h.objects.has(
          `/${f.h.space.bucket}/sponsors/${f.leagueA}/${body.mediaId}.mp4`
        )
      ).equals(true)
      const long = await upload(
        f.leagueA,
        'reel',
        await syntheticVideo({ seconds: 20, width: 640, height: 360, fps: 30 })
      )
      expect(long.status).equals(400)
      expect(await error(long)).matches(
        /^This reel is 20 seconds\. Reels must be 10 to 15 seconds long\.$/
      )
      const fast = await upload(
        f.leagueA,
        'reel',
        await syntheticVideo({ seconds: 12, width: 640, height: 360, fps: 60 })
      )
      expect(fast.status).equals(400)
      expect(await error(fast)).equals(
        'Reels can be at most 30 frames a second.'
      )
    })

    it('refuses a 100 × 100 row logo, an unknown purpose and an empty body', async function () {
      const small = await upload(f.leagueA, 'rowLogo', pngBytes(100, 100))
      expect(small.status).equals(400)
      expect(await error(small)).equals('Row logos must be 128 × 128 pixels.')
      const purpose = await upload(f.leagueA, 'banner', pngBytes(100, 100))
      expect(purpose.status).equals(400)
      expect(await error(purpose)).matches(/^purpose must be one of/)
      const empty = await upload(f.leagueA, 'logo', new Uint8Array())
      expect(empty.status).equals(400)
      expect(await error(empty)).equals('Choose a file to upload.')
      const background = await upload(
        f.leagueA,
        'rowBackground',
        jpegBytes(1920, 224)
      )
      expect(background.status).equals(201)
      expect(((await background.json()) as { url: string }).url).matches(
        /\.jpg$/
      )
    })
  })

  describe('allocations', function () {
    it('refuses allocations over the total, another league’s or a used upload, and an empty name', async function () {
      const logo = await mediaId(f.leagueB, 'logo', pngBytes(200, 100))
      const over = await f.h.request(
        'POST',
        `/leagues/${f.leagueB}/sponsors/logos`,
        { mediaId: logo, name: 'Harbor', allocation: 301 },
        102
      )
      expect(over.status).equals(400)
      expect(await error(over)).equals(
        'Only 300 game logo credits are left to assign.'
      )
      const theirs = await f.h.request(
        'POST',
        `/leagues/${f.leagueA}/sponsors/logos`,
        { mediaId: logo, name: 'Harbor', allocation: 10 }
      )
      expect(theirs.status).equals(400)
      expect(await error(theirs)).matches(/^Upload the logo first/)
      const unnamed = await f.h.request(
        'POST',
        `/leagues/${f.leagueB}/sponsors/logos`,
        { mediaId: logo, name: '  ', allocation: 10 },
        102
      )
      expect(await error(unnamed)).equals(
        'Enter a name of at most 80 characters.'
      )
      await stateOf(
        await f.h.request(
          'POST',
          `/leagues/${f.leagueB}/sponsors/logos`,
          { mediaId: logo, name: 'Harbor', allocation: 50 },
          102
        )
      )
      const again = await f.h.request(
        'POST',
        `/leagues/${f.leagueB}/sponsors/logos`,
        { mediaId: logo, name: 'Harbor again', allocation: 50 },
        102
      )
      expect(await error(again)).equals('That logo is already listed.')
      const malformed = await f.h.request(
        'POST',
        `/leagues/${f.leagueB}/sponsors/logos`,
        { mediaId: logo },
        102
      )
      expect(malformed.status).equals(400)
    })

    it('leaves one of two concurrent adds that together pass the total refused', async function () {
      const [one, two] = await Promise.all([
        mediaId(f.leagueA, 'logo', pngBytes(201, 100)),
        mediaId(f.leagueA, 'logo', pngBytes(202, 100))
      ])
      const left = (await read(f.leagueA)).logos.reduce(
        (total, logo) => total - logo.allocation,
        300
      )
      const answers = await Promise.all(
        [one, two].map(
          async id =>
            await f.h.request('POST', `/leagues/${f.leagueA}/sponsors/logos`, {
              mediaId: id,
              name: id,
              allocation: left - 10
            })
        )
      )
      expect(
        answers.map(answer => answer.status).sort((a, b) => a - b)
      ).deep.equals([201, 400])
    })

    it('keeps a used logo inactive and deletes an unused one, and its pool can then not change', async function () {
      const used = await mediaId(f.leagueB, 'logo', pngBytes(210, 100))
      const unused = await mediaId(f.leagueB, 'logo', pngBytes(211, 100))
      for (const id of [used, unused])
        await stateOf(
          await f.h.request(
            'POST',
            `/leagues/${f.leagueB}/sponsors/logos`,
            { mediaId: id, name: id, allocation: 20 },
            102
          )
        )
      const rows = await f.h.db
        .selectFrom('sponsor_logos')
        .select(['id', 'media_id'])
        .where('media_id', 'in', [used, unused])
        .execute()
      const idOf = (media: string): string =>
        rows.find(row => row.media_id === media)!.id
      await f.h.db
        .updateTable('sponsor_logos')
        .set({ used: 3 })
        .where('id', '=', idOf(used))
        .execute()
      const raised = await stateOf(
        await f.h.request(
          'PATCH',
          `/sponsors/logos/${idOf(used)}`,
          { allocation: 25 },
          102
        )
      )
      expect(
        raised.logos.find(logo => logo.id === idOf(used))?.allocation
      ).equals(25)
      const below = await f.h.request(
        'PATCH',
        `/sponsors/logos/${idOf(used)}`,
        { allocation: 2 },
        102
      )
      expect(await error(below)).equals(
        `${used} has used 3; its pool can't be smaller.`
      )
      const kept = await stateOf(
        await f.h.request(
          'POST',
          `/sponsors/logos/${idOf(used)}/deactivate`,
          undefined,
          102
        )
      )
      expect(kept.logos.find(logo => logo.id === idOf(used))).to.include({
        active: false,
        allocation: 25,
        used: 3
      })
      const gone = await stateOf(
        await f.h.request(
          'POST',
          `/sponsors/logos/${idOf(unused)}/deactivate`,
          undefined,
          102
        )
      )
      expect(gone.logos.map(logo => logo.id)).not.includes(idOf(unused))
      const frozen = await f.h.request(
        'PATCH',
        `/sponsors/logos/${idOf(used)}`,
        { allocation: 30 },
        102
      )
      expect(await error(frozen)).equals(
        `${used} is inactive; its pool can't change.`
      )
    })

    it('lists, changes and deactivates reels against the broadcast credits', async function () {
      const reel = await mediaId(f.leagueB, 'reel', reel12)
      const over = await f.h.request(
        'POST',
        `/leagues/${f.leagueB}/sponsors/reels`,
        { mediaId: reel, name: 'Ridgeview', allocation: 1001 },
        102
      )
      expect(await error(over)).equals(
        'Only 1,000 broadcast credits are left to assign.'
      )
      const logoUpload = await mediaId(f.leagueB, 'logo', pngBytes(212, 100))
      const wrong = await f.h.request(
        'POST',
        `/leagues/${f.leagueB}/sponsors/reels`,
        { mediaId: logoUpload, name: 'Ridgeview', allocation: 10 },
        102
      )
      expect(await error(wrong)).matches(/^Upload the reel first/)
      const listed = await stateOf(
        await f.h.request(
          'POST',
          `/leagues/${f.leagueB}/sponsors/reels`,
          { mediaId: reel, name: 'Ridgeview', allocation: 100 },
          102
        )
      )
      const [row] = listed.reels
      expect(row.durationSec).within(11.9, 12.1)
      expect(row.posterUrl).equals('')
      const again = await f.h.request(
        'POST',
        `/leagues/${f.leagueB}/sponsors/reels`,
        { mediaId: reel, name: 'Ridgeview', allocation: 10 },
        102
      )
      expect(await error(again)).equals('That reel is already listed.')
      const changed = await stateOf(
        await f.h.request(
          'PATCH',
          `/sponsors/reels/${row.id}`,
          { allocation: 400 },
          102
        )
      )
      expect(changed.reels[0].allocation).equals(400)
      const removed = await stateOf(
        await f.h.request(
          'POST',
          `/sponsors/reels/${row.id}/deactivate`,
          undefined,
          102
        )
      )
      expect(removed.reels).deep.equals([])
    })
  })

  describe('rows', function () {
    const row = (
      logoMediaId: string,
      backgroundMediaId: string
    ): Record<string, string> => ({
      logoMediaId,
      backgroundMediaId,
      title: 'Harbor Hardware',
      message: 'Ten percent off for league families.',
      url: 'https://harbor.example.test/league',
      textColor: 'white',
      startsAt: '2027-04-01T18:00:00.000Z'
    })
    let logo: string
    let background: string
    before(async function () {
      logo = await mediaId(bare, 'rowLogo', pngBytes(128, 128))
      background = await mediaId(bare, 'rowBackground', jpegBytes(1200, 200))
    })

    it('uses a slot for each row, and refuses one at 0 slots', async function () {
      const placed = await stateOf(
        await f.h.request(
          'POST',
          `/leagues/${bare}/sponsors/rows`,
          row(logo, background)
        )
      )
      expect(placed.placements).has.length(1)
      expect(placed.placements[0]).to.include({
        title: 'Harbor Hardware',
        textColor: 'white',
        startsAt: '2027-04-01T18:00:00.000Z',
        placedAt: new Date(now).toISOString()
      })
      await f.h.db
        .updateTable('league_sponsor_credits')
        .set({ event_slots: 1 })
        .where('league_id', '=', bare)
        .execute()
      const full = await f.h.request(
        'POST',
        `/leagues/${bare}/sponsors/rows`,
        row(logo, background)
      )
      expect(full.status).equals(400)
      expect(await error(full)).equals('All event stream slots are used.')
      await f.h.db
        .updateTable('league_sponsor_credits')
        .set({ event_slots: 10 })
        .where('league_id', '=', bare)
        .execute()
    })

    it('refuses an http:// URL, a 21-character title, and another league’s pictures', async function () {
      const plain = await f.h.request(
        'POST',
        `/leagues/${bare}/sponsors/rows`,
        {
          ...row(logo, background),
          url: 'http://harbor.example.test',
          title: 'x'.repeat(21)
        }
      )
      expect(plain.status).equals(400)
      expect(await error(plain)).equals(
        'Titles can be at most 20 characters. Use an https:// address.'
      )
      const swapped = await f.h.request(
        'POST',
        `/leagues/${bare}/sponsors/rows`,
        row(background, background)
      )
      expect(await error(swapped)).matches(/^Upload the row's logo first/)
      const noBackground = await f.h.request(
        'POST',
        `/leagues/${bare}/sponsors/rows`,
        row(logo, logo)
      )
      expect(await error(noBackground)).matches(
        /^Upload the row's background first/
      )
    })

    it('edits within 24 hours, replacing only the picture sent, and refuses after', async function () {
      const placed = await stateOf(
        await f.h.request(
          'POST',
          `/leagues/${bare}/sponsors/rows`,
          row(logo, background)
        )
      )
      const added = placed.placements.at(-1)!
      const newLogo = await mediaId(bare, 'rowLogo', jpegBytes(128, 128))
      now += 23 * HOUR
      const edited = await stateOf(
        await f.h.request('PATCH', `/sponsors/rows/${added.id}`, {
          logoMediaId: newLogo,
          startsAt: '2027-04-02T18:00:00.000Z',
          textColor: 'dark'
        })
      )
      const after = edited.placements.find(each => each.id === added.id)!
      expect(after.logoUrl).matches(new RegExp(`${newLogo}\\.jpg$`))
      expect(after.backgroundUrl).equals(added.backgroundUrl)
      expect(after).to.include({
        startsAt: '2027-04-02T18:00:00.000Z',
        textColor: 'dark',
        title: 'Harbor Hardware'
      })
      const bad = await f.h.request('PATCH', `/sponsors/rows/${added.id}`, {
        url: 'http://harbor.example.test'
      })
      expect(await error(bad)).equals('Use an https:// address.')
      const otherBackground = await f.h.request(
        'PATCH',
        `/sponsors/rows/${added.id}`,
        { backgroundMediaId: newLogo }
      )
      expect(await error(otherBackground)).matches(
        /^Upload the row's background first/
      )
      now += HOUR
      const late = await f.h.request('PATCH', `/sponsors/rows/${added.id}`, {
        title: 'Late'
      })
      expect(late.status).equals(400)
      expect(await error(late)).equals(
        'This placement is more than 24 hours old; it can only be deleted.'
      )
      expect(
        (await read(bare)).placements.map(each => each.title)
      ).not.includes('Late')
    })

    it('returns the slot on a delete within 24 hours, and keeps it after', async function () {
      const before = await read(bare)
      const fresh = await stateOf(
        await f.h.request(
          'POST',
          `/leagues/${bare}/sponsors/rows`,
          row(logo, background)
        )
      )
      const added = fresh.placements.find(
        each => !before.placements.some(old => old.id === each.id)
      )!
      const early = await stateOf(
        await f.h.request('DELETE', `/sponsors/rows/${added.id}`)
      )
      expect(early.keptSlots).equals(before.keptSlots)
      expect(early.placements).has.length(before.placements.length)
      // The first row was placed more than 24 hours ago.
      const old = before.placements[0]
      const late = await stateOf(
        await f.h.request('DELETE', `/sponsors/rows/${old.id}`)
      )
      expect(late.keptSlots).equals(before.keptSlots + 1)
      expect(late.placements.map(each => each.id)).not.includes(old.id)
      expect(
        (await f.h.request('DELETE', `/sponsors/rows/${old.id}`)).status
      ).equals(404)
    })
  })

  describe('a league with no credits row', function () {
    it('reads 300 / 1,000 / 10, and two concurrent over-total adds leave one refused', async function () {
      const league = 'lea_sponsor_bare_two'
      await f.h.db
        .insertInto('leagues')
        .values({ id: league, name: 'Second Bare League' })
        .execute()
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: 'rol_sponsor_bare_two',
          user_id: userIdOfGumbo(101),
          scope_type: 'league',
          scope_id: league,
          role: 'admin',
          granted_by: null
        })
        .execute()
      const [one, two] = [
        await mediaId(league, 'logo', pngBytes(300, 100)),
        await mediaId(league, 'logo', pngBytes(301, 100))
      ]
      expect(
        await f.h.db
          .selectFrom('league_sponsor_credits')
          .select('league_id')
          .where('league_id', '=', league)
          .execute()
      ).deep.equals([])
      const answers = await Promise.all(
        [one, two].map(
          async id =>
            await f.h.request('POST', `/leagues/${league}/sponsors/logos`, {
              mediaId: id,
              name: id,
              allocation: 200
            })
        )
      )
      expect(
        answers.map(answer => answer.status).sort((a, b) => a - b)
      ).deep.equals([201, 400])
      const state = await read(league)
      expect(state.totals).deep.equals({
        logoCredits: 300,
        reelCredits: 1000,
        eventSlots: 10
      })
    })
  })

  describe('the media sweep', function () {
    // The sweeps tell no player anything yet, and this database throws.
    const noStore = {} as unknown as ScoreboardStore
    const brokenDb = {
      selectFrom: () => {
        throw new Error('no database')
      }
    } as unknown as Kysely<Database>
    it('deletes uploads older than a day that nothing uses, with their objects, and keeps the rest', async function () {
      const unused = await mediaId(f.leagueA, 'logo', pngBytes(220, 100))
      const fresh = await mediaId(f.leagueA, 'logo', pngBytes(221, 100))
      const listed = await mediaId(f.leagueA, 'logo', pngBytes(222, 100))
      await stateOf(
        await f.h.request('POST', `/leagues/${f.leagueA}/sponsors/logos`, {
          mediaId: listed,
          name: 'Listed',
          allocation: 1
        })
      )
      const old = new Date(Date.now() - UNUSED_MEDIA_MS - 1000)
      await f.h.db
        .updateTable('sponsor_media')
        .set({ created_at: old })
        .where('id', 'in', [unused, listed])
        .execute()
      const keyOf = async (id: string): Promise<string> =>
        `/${f.h.space.bucket}/${
          (
            await f.h.db
              .selectFrom('sponsor_media')
              .select('object_key')
              .where('id', '=', id)
              .executeTakeFirstOrThrow()
          ).object_key
        }`
      const unusedKey = await keyOf(unused)
      expect(f.h.objects.has(unusedKey)).equals(true)
      const logged: string[] = []
      // Every old upload the earlier cases left unused goes too.
      const gone = await sweepSponsorMedia(
        f.h.db,
        f.h.space,
        new Date(),
        message => logged.push(message)
      )
      expect(gone).greaterThan(0)
      expect(logged).deep.equals([])
      const left = (
        await f.h.db
          .selectFrom('sponsor_media')
          .select('id')
          .where('id', 'in', [unused, fresh, listed])
          .execute()
      ).map(row => row.id)
      expect(left.sort()).deep.equals([fresh, listed].sort())
      expect(f.h.objects.has(unusedKey)).equals(false)
      expect(await sweepSponsorMedia(f.h.db, f.h.space, new Date())).equals(0)
    })

    it('logs an object it could not delete, and still forgets the row', async function () {
      const unused = await mediaId(f.leagueA, 'logo', pngBytes(223, 100))
      await f.h.db
        .updateTable('sponsor_media')
        .set({ created_at: new Date(Date.now() - UNUSED_MEDIA_MS - 1000) })
        .where('id', '=', unused)
        .execute()
      const logged: string[] = []
      const broken = { ...f.h.space, endpoint: 'http://127.0.0.1:9' }
      expect(
        await sweepSponsorMedia(f.h.db, broken, new Date(), message =>
          logged.push(message)
        )
      ).equals(1)
      expect(logged).has.length(1)
      expect(logged[0]).matches(/^sponsor media sweep: /)
    })

    it('runs on the way up and on its period, once a node, and stops with its store', async function () {
      const unused = await mediaId(f.leagueA, 'logo', pngBytes(224, 100))
      await f.h.db
        .updateTable('sponsor_media')
        .set({ created_at: new Date(Date.now() - UNUSED_MEDIA_MS - 1000) })
        .where('id', '=', unused)
        .execute()
      const logged: string[] = []
      let closed = 0
      const sweeps = startSponsorSweeps({
        db: f.h.db,
        space: f.h.space,
        redis: { url: 'redis://127.0.0.1:1', prefix: 'unused' },
        databaseUrl: 'postgres://localhost/unused',
        log: message => logged.push(message),
        makeStore: () => ({
          store: noStore,
          close: async () => {
            closed++
          }
        })
      })
      for (let wait = 0; wait < 100 && logged.length === 0; wait++)
        await new Promise(resolve => setTimeout(resolve, 50))
      expect(logged).deep.equals(['swept 1 unused sponsor upload(s)'])
      await sweeps.stop()
      expect(closed).equals(1)
    })

    it('logs a sweep that fails, and needs no Space to start or stop', async function () {
      const logged: string[] = []
      const failing = startSponsorSweeps({
        db: brokenDb,
        space: f.h.space,
        redis: { url: 'redis://127.0.0.1:1', prefix: 'unused' },
        databaseUrl: 'postgres://localhost/unused',
        log: message => logged.push(message),
        makeStore: () => ({ store: noStore, close: async () => undefined })
      })
      // The two reel sweeps, the logo settle and the media sweep, each
      // failing on its own.
      for (let wait = 0; wait < 100 && logged.length < 4; wait++)
        await new Promise(resolve => setTimeout(resolve, 20))
      expect(logged.slice(0, 4)).deep.equals(
        Array(4).fill('sponsor sweeps: Error: no database')
      )
      await failing.stop()
      // Its own Valkey connection, started and not waited for.
      const own = startSponsorSweeps({
        db: f.h.db,
        space: { ...f.h.space, bucket: '' },
        redis: {
          url: process.env.TS_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15',
          prefix: ''
        },
        databaseUrl: 'postgres://localhost/sponsor_sweeps',
        log: () => undefined
      })
      expect(own.store).not.equals(undefined)
      await own.stop()
      const away = startSponsorSweeps({
        db: f.h.db,
        space: { ...f.h.space, bucket: '' },
        redis: { url: 'redis://127.0.0.1:1', prefix: 'away' },
        databaseUrl: 'postgres://localhost/sponsor_sweeps',
        log: () => undefined
      })
      await away.stop()
    })
  })

  describe('the state’s fields', function () {
    it('names the media URLs, the reel length in seconds and no poster or version', async function () {
      const league = f.leagueB
      const state = await read(league)
      const keys = await f.h.db
        .selectFrom('sponsor_media')
        .select(['id', 'object_key'])
        .where('league_id', '=', league)
        .execute()
      const urls = new Set(
        keys.map(key => `${mediaBase(f.h.space)}/${key.object_key}`)
      )
      expect(state.logos.length).greaterThan(0)
      for (const logo of state.logos) {
        expect(urls.has(logo.imageUrl), logo.imageUrl).equals(true)
        expect(logo).not.to.have.property('version')
      }
      const reel = await mediaId(league, 'reel', reel12)
      const listed = await stateOf(
        await f.h.request(
          'POST',
          `/leagues/${league}/sponsors/reels`,
          { mediaId: reel, name: 'Reel', allocation: 5 },
          102
        )
      )
      const [row] = listed.reels
      const media = await f.h.db
        .selectFrom('sponsor_media')
        .select(['object_key', 'duration_ms'])
        .where('id', '=', reel)
        .executeTakeFirstOrThrow()
      expect(row.videoUrl).equals(`${mediaBase(f.h.space)}/${media.object_key}`)
      expect(row.durationSec).equals(media.duration_ms! / 1000)
      expect(row.posterUrl).equals('')
      expect(row).not.to.have.property('version')
    })
  })
})
