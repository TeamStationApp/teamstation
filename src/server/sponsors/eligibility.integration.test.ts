import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type { GameSponsors } from '../../common/sponsors/types'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { createSession } from '../auth/sessions'
import { sponsorRoutes } from '../routes/sponsors'
import { pickSide, type SponsorSide } from './eligibility'
import { assignGameLogos } from './logos'
import { placeReel } from './reels'

const NOW = new Date('2027-04-10T18:00:00.000Z')
const HOUR = 60 * 60 * 1000

/** U29: which league's sponsorship each viewer of a game is answered. */
describe('U29 sponsor eligibility', function () {
  this.timeout(120000)
  let f: GroupFixture
  const uploads = mkdtempSync(join(tmpdir(), 'sponsor-eligibility-'))
  let keys = 0
  const key = (): string => `${++keys}`
  let gumbos = 771000

  /** A league with a logo and a reel, so each game it sponsors has both. */
  const league = async (): Promise<string> => {
    const id = `lea_elig_${key()}`
    await f.h.db.insertInto('leagues').values({ id, name: id }).execute()
    for (const purpose of ['logo', 'reel'] as const) {
      const mediaId = makeId('sponsorMedia')
      await f.h.db
        .insertInto('sponsor_media')
        .values({
          id: mediaId,
          league_id: id,
          purpose,
          object_key: `sponsors/${id}/${mediaId}.${purpose === 'logo' ? 'png' : 'mp4'}`,
          content_type: purpose === 'logo' ? 'image/png' : 'video/mp4',
          bytes: 100,
          sha256: randomBytes(32).toString('hex'),
          width: purpose === 'logo' ? 480 : 640,
          height: purpose === 'logo' ? 120 : 360,
          duration_ms: purpose === 'logo' ? null : 12000,
          created_by: null
        })
        .execute()
      const row = {
        league_id: id,
        media_id: mediaId,
        name: `${id} ${purpose}`,
        allocation: 100,
        used: 0,
        active: true,
        position: 1,
        accepted_at: new Date(NOW.getTime() - HOUR)
      }
      if (purpose === 'logo')
        await f.h.db
          .insertInto('sponsor_logos')
          .values({ id: makeId('sponsorLogo'), ...row })
          .execute()
      else
        await f.h.db
          .insertInto('sponsor_reels')
          .values({ id: makeId('sponsorReel'), ...row, duration_ms: 12000 })
          .execute()
    }
    return id
  }
  /** A league with no sponsor media at all. */
  const bareLeague = async (): Promise<string> => {
    const id = `lea_elig_${key()}`
    await f.h.db.insertInto('leagues').values({ id, name: id }).execute()
    return id
  }
  const team = async (leagueId: string | null): Promise<string> => {
    const id = `tem_elig_${key()}`
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
  const season = async (
    leagueId: string,
    teamIds: string[]
  ): Promise<string> => {
    const id = `sea_elig_${key()}`
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
    await f.h.db
      .insertInto('season_teams')
      .values(
        teamIds.map(teamId => ({
          season_id: id,
          team_id: teamId,
          active: true
        }))
      )
      .execute()
    return id
  }
  /**
   * A game of `home` and `away`, its logos given and a pre-game reel placed
   * for each of its teams' leagues.
   */
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
    await assignGameLogos(f.h.db, id, NOW)
    const leagues = await f.h.db
      .selectFrom('teams')
      .select('league_id')
      .where('id', 'in', [home, away])
      .execute()
    for (const leagueId of new Set(leagues.map(row => row.league_id)))
      if (leagueId != null)
        await placeReel(f.h.db, id, leagueId, { slot: 'pregame' }, NOW)
    return id
  }
  /**
   * A game made as `game` makes it, again until the hash gives `viewer`
   * the `side` wanted, so a neutral answer can be told from an associated one.
   */
  const gameWherePick = async (
    viewer: Viewer,
    side: SponsorSide,
    home: string,
    away: string,
    seasonId: string | null = null
  ): Promise<string> => {
    for (;;) {
      const id = await game(home, away, seasonId)
      if (pickSide(id, viewer.userId) === side) return id
    }
  }

  interface Viewer {
    userId: string
    token: string
  }
  const viewer = async (): Promise<Viewer> => {
    const gumbo = ++gumbos
    await insertFixtureUsers(f.h.db, {
      id: gumbo,
      display_name: `Viewer ${gumbo}`,
      login_enabled: true
    })
    const userId = userIdOfGumbo(gumbo)
    return {
      userId,
      token: (await createSession(f.h.db, userId, 'eligibility')).token
    }
  }
  const member = async (who: Viewer, teamId: string): Promise<string> => {
    const id = makeId('membership')
    await f.h.db
      .insertInto('memberships')
      .values({ id, user_id: who.userId, team_id: teamId, is_player: true })
      .execute()
    return id
  }
  const role = async (
    who: Viewer,
    scopeType: 'league' | 'season' | 'team',
    scopeId: string
  ): Promise<void> => {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: who.userId,
        scope_type: scopeType,
        scope_id: scopeId,
        role: 'admin',
        granted_by: null
      })
      .execute()
  }

  const read = async (gameId: string, who: Viewer | null): Promise<Response> =>
    await f.h.request(
      'GET',
      `/games/${gameId}/sponsors`,
      undefined,
      who?.token ?? null
    )
  /** The league answered, checked to be the logo's and every reel's. */
  const leagueSeen = async (
    gameId: string,
    who: Viewer
  ): Promise<string | null> => {
    const response = await read(gameId, who)
    expect(response.status).equals(200)
    const answer = (await response.json()) as GameSponsors
    if (answer.leagueId == null) {
      expect(answer.logo).equals(null)
      expect(answer.reels).deep.equals([])
      return null
    }
    expect(answer.logo?.url).contains(`/sponsors/${answer.leagueId}/`)
    expect(answer.reels).length(1)
    expect(answer.reels[0].url).contains(`/sponsors/${answer.leagueId}/`)
    return answer.leagueId
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

  describe('associated viewers', function () {
    it('gives a home player home’s league, and the away team’s on the next read once the membership moves', async function () {
      const american = await league()
      const national = await league()
      const yankees = await team(american)
      const dodgers = await team(national)
      const player = await viewer()
      const membership = await member(player, yankees)
      // The hash would give away: the membership is what picks home.
      const gameId = await gameWherePick(player, 'away', yankees, dodgers)
      expect(await leagueSeen(gameId, player)).equals(american)
      await f.h.db
        .updateTable('memberships')
        .set({ team_id: dodgers })
        .where('id', '=', membership)
        .execute()
      expect(await leagueSeen(gameId, player)).equals(national)
    })

    it('gives a team admin, and a guardian of a player, that team’s league', async function () {
      const american = await league()
      const national = await league()
      const yankees = await team(american)
      const dodgers = await team(national)
      const admin = await viewer()
      await role(admin, 'team', dodgers)
      const parent = await viewer()
      const child = await viewer()
      await member(child, dodgers)
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: parent.userId,
          related_user_id: child.userId,
          kind: 'guardian'
        })
        .execute()
      for (const who of [admin, parent]) {
        const gameId = await gameWherePick(who, 'home', yankees, dodgers)
        expect(await leagueSeen(gameId, who)).equals(national)
      }
    })

    it('gives an admin of the season’s league its own team in an interleague game of its season', async function () {
      const american = await league()
      const national = await league()
      const yankees = await team(american)
      const dodgers = await team(national)
      const seasonId = await season(american, [yankees, dodgers])
      const admin = await viewer()
      await role(admin, 'league', american)
      const gameId = await gameWherePick(
        admin,
        'away',
        yankees,
        dodgers,
        seasonId
      )
      expect(await leagueSeen(gameId, admin)).equals(american)
    })
  })

  describe('neutral viewers', function () {
    it('gives an admin of the game’s season, a member of it and a viewer on both teams the hash’s side on every read', async function () {
      const american = await league()
      const national = await league()
      const yankees = await team(american)
      const dodgers = await team(national)
      const seasonId = await season(american, [yankees, dodgers])
      const seasonAdmin = await viewer()
      await role(seasonAdmin, 'season', seasonId)
      const seasonMember = await viewer()
      await f.h.db
        .insertInto('season_members')
        .values({
          id: makeId('seasonMember'),
          user_id: seasonMember.userId,
          season_id: seasonId
        })
        .execute()
      const both = await viewer()
      await member(both, yankees)
      await member(both, dodgers)
      for (const who of [seasonAdmin, seasonMember, both])
        for (const side of ['home', 'away'] as const) {
          const gameId = await gameWherePick(
            who,
            side,
            yankees,
            dodgers,
            seasonId
          )
          const expected = side === 'home' ? american : national
          for (let i = 0; i < 3; i++)
            expect(await leagueSeen(gameId, who)).equals(expected)
        }
    })

    it('leaves an admin of league A neutral for its team in another league’s season', async function () {
      const american = await league()
      const national = await league()
      const yankees = await team(american)
      const dodgers = await team(national)
      const nlSeason = await season(national, [yankees, dodgers])
      const alAdmin = await viewer()
      await role(alAdmin, 'league', american)
      // Seen through the Yankees, the AL's own team, and still neutral: the
      // hash gives the Dodgers' side and so the NL's track.
      const gameId = await gameWherePick(
        alAdmin,
        'away',
        yankees,
        dodgers,
        nlSeason
      )
      expect(await leagueSeen(gameId, alAdmin)).equals(national)
      // In no season, as well.
      const loose = await gameWherePick(alAdmin, 'away', yankees, dodgers)
      expect(await leagueSeen(loose, alAdmin)).equals(national)
    })
  })

  it('is 401 signed out, as playback is', async function () {
    const american = await league()
    const gameId = await game(await team(american), await team(american))
    expect((await read(gameId, null)).status).equals(401)
  })

  it('answers no league, logo or reels when the picked side’s league sponsors nothing, or it is in none', async function () {
    const american = await league()
    const bare = await bareLeague()
    const yankees = await team(american)
    const unsponsored = await team(bare)
    const loose = await team(null)
    const who = await viewer()
    await member(who, unsponsored)
    const gameId = await game(unsponsored, yankees)
    expect(await leagueSeen(gameId, who)).equals(null)
    const nowhere = await viewer()
    await member(nowhere, loose)
    expect(await leagueSeen(await game(loose, yankees), nowhere)).equals(null)
  })

  it('is 404 for a viewer who cannot play the game', async function () {
    const american = await league()
    const gameId = await game(await team(american), await team(american))
    expect((await read(gameId, await viewer())).status).equals(404)
  })
})
