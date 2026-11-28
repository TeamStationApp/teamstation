import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { defaultSponsorSettings } from '../../common/nodeSettings'
import type { GameSponsors } from '../../common/sponsors/types'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { sponsorRoutes } from '../routes/sponsors'
import { addCreditRow, deactivateCreditRow, mediaUrl } from './credits'
import {
  assignGameLogos,
  gameSponsorsFor,
  LOGO_CHARGE_SEC,
  settleGameLogos
} from './logos'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const NOW = new Date('2027-04-10T18:00:00.000Z')
const at = (ms: number): Date => new Date(NOW.getTime() + ms)

/** U15: a game's sponsor logo, from its first recording to its charge. */
describe('U15 game sponsor logos', function () {
  this.timeout(120000)
  let f: GroupFixture
  const uploads = mkdtempSync(join(tmpdir(), 'sponsor-logos-'))
  let keys = 0
  const key = (): string => `${++keys}`

  /** A league straight in `leagues`: no credits row until one is read. */
  const league = async (): Promise<string> => {
    const id = `lea_logos_${key()}`
    await f.h.db.insertInto('leagues').values({ id, name: id }).execute()
    return id
  }
  const team = async (leagueId: string | null): Promise<string> => {
    const id = `tem_logos_${key()}`
    await f.h.db
      .insertInto('teams')
      .values({
        id,
        name: id,
        league_id: leagueId,
        kind: 'full',
        created_from: 'manual'
      })
      .execute()
    return id
  }
  const season = async (leagueId: string): Promise<string> => {
    const id = `sea_logos_${key()}`
    await f.h.db
      .insertInto('seasons')
      .values({
        id,
        name: id,
        league_id: leagueId,
        year: 2027,
        starts_on: '2027-03-01',
        ends_on: '2027-05-31'
      })
      .execute()
    return id
  }
  const game = async (
    home: string,
    away: string,
    seasonId: string | null = null
  ): Promise<string> => {
    const id = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        season_id: seasonId,
        start_at: NOW
      })
      .execute()
    return id
  }
  /** A league's logo, accepted an hour before `NOW` unless said. */
  const logo = async (
    leagueId: string,
    position: number,
    values: Partial<{
      allocation: number
      used: number
      active: boolean
      acceptedAt: Date
    }> = {}
  ): Promise<{ id: string; mediaId: string; key: string }> => {
    const mediaId = makeId('sponsorMedia')
    const objectKey = `sponsors/${leagueId}/${mediaId}.png`
    await f.h.db
      .insertInto('sponsor_media')
      .values({
        id: mediaId,
        league_id: leagueId,
        purpose: 'logo',
        object_key: objectKey,
        content_type: 'image/png',
        bytes: 100,
        sha256: randomBytes(32).toString('hex'),
        width: 480,
        height: 120,
        created_by: null
      })
      .execute()
    const id = makeId('sponsorLogo')
    await f.h.db
      .insertInto('sponsor_logos')
      .values({
        id,
        league_id: leagueId,
        media_id: mediaId,
        name: `Logo ${position}`,
        allocation: values.allocation ?? 10,
        used: values.used ?? 0,
        active: values.active ?? true,
        position,
        accepted_at: values.acceptedAt ?? at(-HOUR)
      })
      .execute()
    return { id, mediaId, key: objectKey }
  }
  const video = async (
    gameId: string,
    values: Partial<{
      status: 'live' | 'processing' | 'ready'
      durationSec: number | null
      startAt: Date | null
      hidden: boolean
    }> = {}
  ): Promise<string> => {
    const id = makeId('video')
    await f.h.db
      .insertInto('videos')
      .values({
        id,
        game_id: gameId,
        kind: 'program',
        title: 'Home Plate',
        storage: 'spaces',
        status: values.status ?? 'ready',
        start_at: values.startAt === undefined ? NOW : values.startAt,
        duration_sec:
          values.durationSec === undefined ? 600 : values.durationSec,
        hidden: values.hidden ?? false,
        space_secret: randomBytes(16).toString('hex'),
        created_at: NOW,
        updated_at: NOW
      })
      .execute()
    return id
  }
  const placements = async (
    gameId: string
  ): Promise<
    Array<{
      league_id: string
      logo_id: string | null
      settled: boolean
      charged: boolean
    }>
  > =>
    (
      await f.h.db
        .selectFrom('game_sponsor_logos')
        .select(['league_id', 'logo_id', 'settled_at', 'charged'])
        .where('game_id', '=', gameId)
        .orderBy('league_id')
        .execute()
    ).map(row => ({
      league_id: row.league_id,
      logo_id: row.logo_id,
      settled: row.settled_at != null,
      charged: row.charged
    }))
  const usedOf = async (logoId: string): Promise<number> =>
    (
      await f.h.db
        .selectFrom('sponsor_logos')
        .select('used')
        .where('id', '=', logoId)
        .executeTakeFirstOrThrow()
    ).used
  /** A game of one league's two teams, the league's logos given. */
  const leagueGame = async (
    leagueId: string
  ): Promise<{ gameId: string; home: string }> => {
    const home = await team(leagueId)
    const away = await team(leagueId)
    return { gameId: await game(home, away), home }
  }

  before(async function () {
    f = await groupFixture(undefined, undefined, (app, { db, media }) => {
      app.use(
        '/api/v1',
        sponsorRoutes(db, media, { uploadsDir: uploads, clock: () => NOW })
      )
    })
  })

  after(async function () {
    await f?.h.close()
    rmSync(uploads, { recursive: true, force: true })
  })

  describe('assignment', function () {
    it('gives four games three logos round-robin in acceptance order, and moves the turn', async function () {
      const id = await league()
      const logos = [await logo(id, 1), await logo(id, 2), await logo(id, 3)]
      const given: Array<string | null> = []
      for (let i = 0; i < 4; i++) {
        const { gameId } = await leagueGame(id)
        expect(await assignGameLogos(f.h.db, gameId, NOW)).deep.equals([id])
        given.push((await placements(gameId))[0]?.logo_id ?? null)
      }
      expect(given).deep.equals([
        logos[0].id,
        logos[1].id,
        logos[2].id,
        logos[0].id
      ])
      const credits = await f.h.db
        .selectFrom('league_sponsor_credits')
        .select('logo_turn')
        .where('league_id', '=', id)
        .executeTakeFirstOrThrow()
      expect(credits.logo_turn).equals(1)
    })

    it('skips a used-up logo, an inactive one and one accepted after the game began, and gives none with no candidate', async function () {
      const id = await league()
      await logo(id, 1, { allocation: 2, used: 2 })
      await logo(id, 2, { active: false })
      const late = await logo(id, 3, { acceptedAt: at(MIN) })
      const { gameId } = await leagueGame(id)
      expect(await assignGameLogos(f.h.db, gameId, NOW)).deep.equals([])
      expect(await placements(gameId)).deep.equals([])
      // Begun after the late logo's accept, a game has it.
      const later = await leagueGame(id)
      await assignGameLogos(f.h.db, later.gameId, at(2 * MIN))
      expect((await placements(later.gameId))[0]?.logo_id).equals(late.id)
    })

    it('takes the start of a recording already there, so a logo accepted since is not the game’s', async function () {
      const id = await league()
      await logo(id, 1, { acceptedAt: at(-MIN) })
      const { gameId } = await leagueGame(id)
      await video(gameId, { startAt: at(-HOUR) })
      // An angle that starts now, an hour after the game's first did.
      expect(await assignGameLogos(f.h.db, gameId, NOW)).deep.equals([])
    })

    it('gives none once the league’s charged logos reach its credits', async function () {
      const id = await league()
      await logo(id, 1, { allocation: 5, used: 2 })
      await f.h.db
        .insertInto('league_sponsor_credits')
        .values({ league_id: id, logo_credits: 2 })
        .execute()
      const { gameId } = await leagueGame(id)
      expect(await assignGameLogos(f.h.db, gameId, NOW)).deep.equals([])
    })

    it('gives an interleague game one logo a league, keeps a team’s own league in another league’s season, and none for a team in no league', async function () {
      const american = await league()
      const national = await league()
      const al = await logo(american, 1)
      const nl = await logo(national, 1)
      const yankees = await team(american)
      const dodgers = await team(national)
      const both = await game(dodgers, yankees)
      expect((await assignGameLogos(f.h.db, both, NOW)).sort()).deep.equals(
        [american, national].sort()
      )
      expect(
        (await placements(both)).map(row => [row.league_id, row.logo_id])
      ).deep.equals(
        [
          [american, al.id],
          [national, nl.id]
        ].sort((a, b) => a[0].localeCompare(b[0]))
      )
      // In the National League's season, the Yankees keep their own league's.
      const nlSeason = await season(national)
      const nobody = await team(null)
      const visiting = await game(yankees, nobody, nlSeason)
      await assignGameLogos(f.h.db, visiting, NOW)
      expect(
        (await placements(visiting)).map(row => row.league_id)
      ).deep.equals([american])
      const neither = await game(nobody, await team(null), nlSeason)
      expect(await assignGameLogos(f.h.db, neither, NOW)).deep.equals([])
      expect(await assignGameLogos(f.h.db, 'gam_missing', NOW)).deep.equals([])
    })

    it('keeps the logo a game was given when it is asked again, and the turn where it was', async function () {
      const id = await league()
      const first = await logo(id, 1)
      await logo(id, 2)
      const { gameId } = await leagueGame(id)
      await assignGameLogos(f.h.db, gameId, NOW)
      expect(await assignGameLogos(f.h.db, gameId, at(MIN))).deep.equals([])
      expect(await placements(gameId)).deep.equals([
        { league_id: id, logo_id: first.id, settled: false, charged: false }
      ])
      const credits = await f.h.db
        .selectFrom('league_sponsor_credits')
        .select('logo_turn')
        .where('league_id', '=', id)
        .executeTakeFirstOrThrow()
      expect(credits.logo_turn).equals(1)
    })

    it('never reuses the position of a deleted logo whose turn has passed, so a logo added after it is next', async function () {
      const id = await league()
      const first = await logo(id, 1)
      const second = await logo(id, 2)
      for (const expected of [first.id, second.id]) {
        const { gameId } = await leagueGame(id)
        await assignGameLogos(f.h.db, gameId, NOW)
        expect((await placements(gameId))[0]?.logo_id).equals(expected)
      }
      // The second's game is gone and the logo with it, never used.
      await f.h.db
        .deleteFrom('game_sponsor_logos')
        .where('logo_id', '=', second.id)
        .execute()
      await deactivateCreditRow(f.h.db, 'logo', id, second.id, NOW)
      const mediaId = makeId('sponsorMedia')
      await f.h.db
        .insertInto('sponsor_media')
        .values({
          id: mediaId,
          league_id: id,
          purpose: 'logo',
          object_key: `sponsors/${id}/${mediaId}.png`,
          content_type: 'image/png',
          bytes: 100,
          sha256: randomBytes(32).toString('hex'),
          width: 480,
          height: 120,
          created_by: null
        })
        .execute()
      const added = await addCreditRow(
        f.h.db,
        'logo',
        id,
        { mediaId, name: 'Third', allocation: 5 },
        at(-HOUR)
      )
      const { position } = await f.h.db
        .selectFrom('sponsor_logos')
        .select('position')
        .where('id', '=', added)
        .executeTakeFirstOrThrow()
      expect(position).equals(3)
      const { gameId } = await leagueGame(id)
      await assignGameLogos(f.h.db, gameId, NOW)
      expect((await placements(gameId))[0]?.logo_id).equals(added)
    })

    it('makes the starting credits of a league with no credits row, and gives it a logo against them', async function () {
      const id = await league()
      expect(
        await f.h.db
          .selectFrom('league_sponsor_credits')
          .select('league_id')
          .where('league_id', '=', id)
          .executeTakeFirst()
      ).equals(undefined)
      const only = await logo(id, 1)
      const { gameId } = await leagueGame(id)
      await assignGameLogos(f.h.db, gameId, NOW)
      expect((await placements(gameId))[0]?.logo_id).equals(only.id)
      const credits = await f.h.db
        .selectFrom('league_sponsor_credits')
        .select('logo_credits')
        .where('league_id', '=', id)
        .executeTakeFirstOrThrow()
      expect(credits.logo_credits).equals(300)
    })
  })

  describe('charging', function () {
    /** A game with its league's one logo given, and the logo. */
    const given = async (
      allocation = 10
    ): Promise<{ gameId: string; logoId: string }> => {
      const id = await league()
      const { id: logoId } = await logo(id, 1, { allocation })
      const { gameId } = await leagueGame(id)
      await assignGameLogos(f.h.db, gameId, NOW)
      return { gameId, logoId }
    }

    it('charges nothing at 29:59 of a live recording and one game at 30:00', async function () {
      const { gameId, logoId } = await given()
      await video(gameId, {
        status: 'live',
        durationSec: null,
        startAt: at(-(LOGO_CHARGE_SEC - 1) * 1000)
      })
      await settleGameLogos(f.h.db, NOW)
      expect((await placements(gameId))[0]).include({
        settled: false,
        charged: false
      })
      expect(await usedOf(logoId)).equals(0)
      await settleGameLogos(f.h.db, at(1000))
      expect((await placements(gameId))[0]).include({
        settled: true,
        charged: true
      })
      expect(await usedOf(logoId)).equals(1)
      // Settled once: a later sweep charges nothing more.
      await settleGameLogos(f.h.db, at(HOUR))
      expect(await usedOf(logoId)).equals(1)
    })

    it('measures a live recording whose camera has left only to its last publish, so a stream gone at 23 minutes is never charged in its reconnect grace', async function () {
      const { gameId, logoId } = await given()
      const videoId = await video(gameId, {
        status: 'live',
        durationSec: null,
        startAt: at(-23 * MIN)
      })
      const home = (
        await f.h.db
          .selectFrom('games')
          .select('home_team_id')
          .where('id', '=', gameId)
          .$narrowType<{ home_team_id: string }>()
          .executeTakeFirstOrThrow()
      ).home_team_id
      const streamId = makeId('liveStream')
      const streamKey = randomBytes(16).toString('hex')
      await f.h.db
        .insertInto('live_streams')
        .values({
          id: streamId,
          game_id: gameId,
          team_id: home,
          user_id: userIdOfGumbo(103),
          key_hash: randomBytes(32).toString('hex'),
          key_prefix: streamKey.slice(0, 8),
          key_cipher: streamKey,
          state: 'publishing',
          opens_at: at(-HOUR),
          video_id: videoId,
          first_published_at: at(-23 * MIN),
          last_published_at: NOW
        })
        .execute()
      // The camera leaves at minute 23; the video stays live through the
      // reconnect grace, past minute 30.
      await f.h.db
        .updateTable('live_streams')
        .set({ state: 'idle' })
        .where('id', '=', streamId)
        .execute()
      await settleGameLogos(f.h.db, at(7 * MIN + 30 * 1000))
      expect((await placements(gameId))[0]).include({
        settled: false,
        charged: false
      })
      expect(await usedOf(logoId)).equals(0)
      // It comes back: measured to now again, so minute 30 charges it.
      await f.h.db
        .updateTable('live_streams')
        .set({ state: 'publishing', last_published_at: at(8 * MIN) })
        .where('id', '=', streamId)
        .execute()
      await settleGameLogos(f.h.db, at(8 * MIN))
      expect((await placements(gameId))[0]).include({
        settled: true,
        charged: true
      })
      expect(await usedOf(logoId)).equals(1)
    })

    it('settles free, keeping its logo, a game whose logo ran out first', async function () {
      const id = await league()
      const { id: logoId } = await logo(id, 1, { allocation: 1 })
      const first = await leagueGame(id)
      const second = await leagueGame(id)
      await assignGameLogos(f.h.db, first.gameId, NOW)
      await assignGameLogos(f.h.db, second.gameId, NOW)
      await video(first.gameId, { durationSec: 2400 })
      await settleGameLogos(f.h.db, NOW)
      await video(second.gameId, { durationSec: 2400 })
      await settleGameLogos(f.h.db, NOW)
      expect(await usedOf(logoId)).equals(1)
      expect((await placements(second.gameId))[0]).deep.equals({
        league_id: id,
        logo_id: logoId,
        settled: true,
        charged: false
      })
      expect(
        (await gameSponsorsFor(f.h.db, f.h.space, second.gameId, id)).logo
      ).not.equals(null)
    })

    it('settles a 25-minute upload free and charges a 45-minute one', async function () {
      const short = await given()
      await video(short.gameId, { durationSec: 25 * 60 })
      const long = await given()
      await video(long.gameId, { durationSec: 45 * 60 })
      await settleGameLogos(f.h.db, NOW)
      expect((await placements(short.gameId))[0]).include({
        settled: true,
        charged: false
      })
      expect(await usedOf(short.logoId)).equals(0)
      expect((await placements(long.gameId))[0]).include({
        settled: true,
        charged: true
      })
      expect(await usedOf(long.logoId)).equals(1)
    })

    it('waits while a recording is live or processing, settles free once it is ready under 30 minutes, and charges nothing for a later 40-minute angle', async function () {
      const { gameId, logoId } = await given()
      const live = await video(gameId, {
        status: 'live',
        durationSec: null,
        startAt: at(-10 * MIN)
      })
      // A camera made and never used is no recording, and holds nothing up.
      await video(gameId, {
        status: 'processing',
        durationSec: null,
        startAt: null,
        hidden: true
      })
      await settleGameLogos(f.h.db, NOW)
      expect((await placements(gameId))[0]?.settled).equals(false)
      await f.h.db
        .updateTable('videos')
        .set({ status: 'processing', duration_sec: 600 })
        .where('id', '=', live)
        .execute()
      await settleGameLogos(f.h.db, NOW)
      expect((await placements(gameId))[0]?.settled).equals(false)
      await f.h.db
        .updateTable('videos')
        .set({ status: 'ready' })
        .where('id', '=', live)
        .execute()
      await settleGameLogos(f.h.db, NOW)
      expect((await placements(gameId))[0]).include({
        settled: true,
        charged: false
      })
      await video(gameId, { durationSec: 40 * 60 })
      await settleGameLogos(f.h.db, NOW)
      expect((await placements(gameId))[0]?.charged).equals(false)
      expect(await usedOf(logoId)).equals(0)
    })

    it('charges once when two sweeps run at once', async function () {
      const { gameId, logoId } = await given()
      await video(gameId, { durationSec: 45 * 60 })
      await Promise.all([
        settleGameLogos(f.h.db, NOW),
        settleGameLogos(f.h.db, NOW),
        settleGameLogos(f.h.db, NOW)
      ])
      expect(await usedOf(logoId)).equals(1)
      expect((await placements(gameId))[0]?.charged).equals(true)
    })

    it('keeps a logo deactivated mid-game, inactive, until its games settle: charged at 30 minutes, or deleted once they all settle free', async function () {
      const exists = async (logoId: string): Promise<boolean> =>
        (await f.h.db
          .selectFrom('sponsor_logos')
          .select('id')
          .where('id', '=', logoId)
          .executeTakeFirst()) != null
      // Ten minutes in, nothing used yet: the logo stays, and still charges.
      const charged = await given()
      await video(charged.gameId, {
        status: 'live',
        durationSec: null,
        startAt: at(-10 * MIN)
      })
      const leagueOf = async (logoId: string): Promise<string> =>
        (
          await f.h.db
            .selectFrom('sponsor_logos')
            .select('league_id')
            .where('id', '=', logoId)
            .executeTakeFirstOrThrow()
        ).league_id
      await deactivateCreditRow(
        f.h.db,
        'logo',
        await leagueOf(charged.logoId),
        charged.logoId,
        NOW
      )
      expect(await exists(charged.logoId)).equals(true)
      // Inactive, it is no candidate for a new game.
      const next = await leagueGame(await leagueOf(charged.logoId))
      expect(await assignGameLogos(f.h.db, next.gameId, NOW)).deep.equals([])
      await settleGameLogos(f.h.db, at(20 * MIN))
      expect((await placements(charged.gameId))[0]).include({
        logo_id: charged.logoId,
        settled: true,
        charged: true
      })
      expect(await usedOf(charged.logoId)).equals(1)
      // A short game: settled free, and the logo, never used, goes.
      const free = await given()
      await video(free.gameId, {
        status: 'live',
        durationSec: null,
        startAt: at(-5 * MIN)
      })
      await deactivateCreditRow(
        f.h.db,
        'logo',
        await leagueOf(free.logoId),
        free.logoId,
        NOW
      )
      await settleGameLogos(f.h.db, NOW)
      expect(await exists(free.logoId)).equals(true)
      await f.h.db
        .updateTable('videos')
        .set({ status: 'ready', duration_sec: 5 * 60 })
        .where('game_id', '=', free.gameId)
        .execute()
      await settleGameLogos(f.h.db, NOW)
      expect((await placements(free.gameId))[0]).include({
        logo_id: null,
        settled: true,
        charged: false
      })
      expect(await exists(free.logoId)).equals(false)
    })

    it('settles free a game whose logo row has gone', async function () {
      const { gameId, logoId } = await given()
      await video(gameId, { durationSec: 45 * 60 })
      await f.h.db
        .deleteFrom('sponsor_logos')
        .where('id', '=', logoId)
        .execute()
      const settled = await settleGameLogos(f.h.db, NOW)
      expect(settled.free).greaterThan(0)
      expect((await placements(gameId))[0]).include({
        logo_id: null,
        settled: true,
        charged: false
      })
    })
  })

  describe('GET /games/:gameId/sponsors', function () {
    const read = async (
      gameId: string,
      user: number | null = 105
    ): Promise<Response> =>
      await f.h.request('GET', `/games/${gameId}/sponsors`, undefined, user)

    it('answers the home league’s logo, the node’s placements and no reels, and charges nothing however often it is read', async function () {
      const id = await league()
      const given = await logo(id, 1)
      const { gameId } = await leagueGame(id)
      await assignGameLogos(f.h.db, gameId, NOW)
      await video(gameId, { durationSec: 45 * 60 })
      let answer: GameSponsors | null = null
      for (let i = 0; i < 50; i++) {
        const response = await read(gameId)
        expect(response.status).equals(200)
        answer = (await response.json()) as GameSponsors
      }
      expect(answer).deep.equals({
        leagueId: id,
        logo: {
          url: mediaUrl(f.h.space, given.key),
          width: 480,
          height: 120
        },
        reels: [],
        overlay: {
          logo: defaultSponsorSettings.logo,
          reel: defaultSponsorSettings.reel
        }
      })
      expect(await usedOf(given.id)).equals(0)
      expect((await placements(gameId))[0]?.settled).equals(false)
    })

    it('answers none for a league that gave the game no logo, and for a game of teams in no league', async function () {
      const bare = await leagueGame(await league())
      expect(await (await read(bare.gameId)).json()).deep.include({
        leagueId: null,
        logo: null,
        reels: []
      })
      const nowhere = await game(await team(null), await team(null))
      expect(await (await read(nowhere)).json()).deep.include({
        leagueId: null,
        logo: null
      })
    })

    it('is 401 signed out, and 404 for a game that is not there or one the caller cannot see', async function () {
      const { gameId } = await leagueGame(await league())
      expect((await read(gameId, null)).status).equals(401)
      expect((await read('gam_missing')).status).equals(404)
      // 104 is on no team of the game and in no season of it.
      expect((await read(gameId, 104)).status).equals(404)
    })
  })
})
