import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import {
  type GuardianFixture,
  guardianFixture
} from '../../test/guardianFixture'

/**
 * The non-member view: anybody signed in who holds no private access to a
 * team, following it or not, reads the team's names, schedule, season table
 * and each game's score, line score and highlights, and is answered
 * `membersOnly` for the figures, the box score and the video itself.
 *
 * On `guardianFixture`: Grace Hill (207) follows Demo Hawks and belongs to
 * nothing. Hank Moss (208) runs Demo Rookies and follows nothing here; the
 * team's coach (104) is a member. `guardian-game-1` is the Hawks at home and
 * is given a line score; `guardian-game-2` is the Hawks away.
 */
const MEMBERS_ONLY = {
  code: 'membersOnly',
  message: 'You need to be a member of one of the teams to see this.'
}

describe('the non-member view', function () {
  this.timeout(120000)

  let f: GuardianFixture
  let follower: number
  let stranger: number
  let member: number
  let game: string
  let video: string

  const side = (runs: number[]): Record<string, unknown> => ({
    runs,
    r: runs.reduce((sum, run) => sum + run, 0),
    h: 7,
    e: 1,
    bb: 3,
    k: 5,
    hr: 1,
    hbp: 2
  })

  before(async function () {
    f = await guardianFixture()
    follower = f.people.follower
    stranger = f.people.oneTeam
    member = f.people.teamCoach
    game = f.games[0].id
    video = f.games[0].videoId
    await f.h.db
      .updateTable('games')
      .set({
        linescore: JSON.stringify({
          away: side([0, 1, 2]),
          home: side([2, 0, 4])
        })
      })
      .where('id', '=', game)
      .execute()
    // The Hawks compete in Demo Regular, so the season has a table, and Demo
    // Eagles, whom nobody here follows, compete in Demo Tournament. Demo
    // Playoffs has no team in it.
    await f.h.db
      .insertInto('season_teams')
      .values([
        { season_id: f.seasonA, team_id: f.teamA, joined_at: new Date() },
        { season_id: f.seasonB, team_id: f.teamB, joined_at: new Date() }
      ])
      .execute()
    // A face on the roster, so a member sees a picture a non-member does not.
    await f.h.db
      .updateTable('users')
      .set({ avatar_path: 'avatars/avery' })
      .where('id', '=', userIdOfGumbo(f.players[0].id))
      .execute()
  })

  after(async function () {
    await f?.h.close()
  })

  const call = async (
    path: string,
    userId: number | null
  ): Promise<{ status: number; body: any }> => {
    const response = await f.h.request('GET', path, undefined, userId)
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? undefined : JSON.parse(text)
    }
  }

  for (const [who, viewer] of [
    ['a follower', () => follower],
    ['a signed-in user who does not follow the team', () => stranger]
  ] as const)
    describe(`for ${who}`, function () {
      it('marks the team page as the non-member view', async function () {
        const { status, body } = await call(`/teams/${f.teamA}`, viewer())
        expect(status).equals(200)
        expect(body.nonMemberView).equals(true)
        expect(body.canViewPrivate).equals(false)
      })

      it('lists every name on the roster, and no picture', async function () {
        const { status, body } = await call(
          `/teams/${f.teamA}/roster`,
          viewer()
        )
        expect(status).equals(200)
        const names = (body as Array<{ shortName: string }>).map(
          row => row.shortName
        )
        for (const player of f.players)
          expect(names).includes(`${player.first} ${player.last[0]}`)
        expect(
          (body as Array<{ avatarUrl: string | null }>).every(
            row => row.avatarUrl === null
          )
        ).equals(true)
        // Avery's guardian is listed as family, without whom he guards.
        const rows = body as Array<{
          userId: string
          section: string
          guardianOf?: string[]
        }>
        expect(
          rows.find(row => row.userId === userIdOfGumbo(f.people.guardian))
            ?.section
        ).equals('family')
        expect(rows.every(row => !('guardianOf' in row))).equals(true)
      })

      it('lists the schedule with video counts, posters and logos', async function () {
        const { status, body } = await call(`/teams/${f.teamA}/games`, viewer())
        expect(status).equals(200)
        const rows = body as Array<{
          id: string
          videoCount: number
          posterUrl: string | null
        }>
        expect(rows.map(row => row.id).sort()).deep.equals(
          f.games.map(g => g.id).sort()
        )
        for (const row of rows) {
          expect(row.videoCount).equals(1)
          expect(row.posterUrl).to.be.a('string')
          expect(row).to.have.property('homeLogoUrl')
          expect(row).to.have.property('awayLogoUrl')
        }
      })

      it('withholds the team’s batting and pitching', async function () {
        for (const query of ['', '?kind=pitching']) {
          const { status, body } = await call(
            `/teams/${f.teamA}/stats${query}`,
            viewer()
          )
          expect(status).equals(403)
          expect(body).deep.equals(MEMBERS_ONLY)
        }
      })

      it('shows the standings of a season with a team in it, and not of one without', async function () {
        const { status, body } = await call(
          `/seasons/${f.seasonA}/standings`,
          viewer()
        )
        expect(status).equals(200)
        expect(
          (body as Array<{ teamId: string }>).map(row => row.teamId)
        ).includes(f.teamA)
        // Every team's page is open to them, and shows where it stands.
        expect(
          (await call(`/seasons/${f.seasonB}/standings`, viewer())).status
        ).equals(200)
        expect(
          (await call(`/seasons/${f.playoffs}/standings`, viewer())).status
        ).equals(404)
      })

      it('shows a game’s score, records and innings, and none of its totals', async function () {
        const { status, body } = await call(`/games/${game}`, viewer())
        expect(status).equals(200)
        expect(body.nonMemberView).equals(true)
        expect(body.canScore).equals(false)
        expect(body.canDj).equals(false)
        expect(body.homeScore).equals(6)
        expect(body).to.have.property('homeRecord')
        expect(body).to.have.property('homeLogoUrl')
        const withheld = {
          h: null,
          e: null,
          bb: null,
          k: null,
          hr: null,
          hbp: null
        }
        expect(body.linescore).deep.equals({
          away: { runs: [0, 1, 2], r: 3, ...withheld },
          home: { runs: [2, 0, 4], r: 6, ...withheld }
        })
        expect(body.videos).to.have.length(1)
        expect(body.videos[0].posterUrl).to.be.a('string')
      })

      it('withholds the box score', async function () {
        const { status, body } = await call(
          `/games/${game}/box-score`,
          viewer()
        )
        expect(status).equals(403)
        expect(body).deep.equals(MEMBERS_ONLY)
      })

      it('lists a video’s highlights with their stills', async function () {
        const { status, body } = await call(
          `/videos/${video}/highlights`,
          viewer()
        )
        expect(status).equals(200)
        expect(body.highlights.length).greaterThan(0)
        for (const highlight of body.highlights)
          expect(highlight.stillUrl).matches(/\/stills\/\d+\.jpg\?t=/)
        // And the signed still answers without anybody signed in.
        const still = await fetch(
          `${f.h.origin}${body.highlights[0].stillUrl}`,
          {
            redirect: 'manual'
          }
        )
        expect(still.status).equals(302)
      })

      it('answers 404 for a hidden video’s highlights, as for its playback', async function () {
        const hide = async (hidden: boolean): Promise<void> => {
          await f.h.db
            .updateTable('videos')
            .set({ hidden })
            .where('id', '=', video)
            .execute()
        }
        await hide(true)
        try {
          for (const who of [viewer(), member]) {
            const { status, body } = await call(
              `/videos/${video}/highlights`,
              who
            )
            expect(status, String(who)).equals(404)
            expect(body.code, String(who)).not.equals('membersOnly')
          }
        } finally {
          await hide(false)
        }
      })

      it('opens only the frame each still URL was handed out for', async function () {
        const { body } = await call(`/videos/${video}/highlights`, viewer())
        const handed = new URL(body.highlights[0].stillUrl, f.h.origin)
        const second = Number(
          /\/stills\/(\d+)\.jpg$/.exec(handed.pathname)?.[1]
        )
        const other = f.games[1].videoId
        for (const path of [
          // Another second of the same video: the next frame of the game.
          handed.pathname.replace(/\d+\.jpg$/, `${second + 1}.jpg`),
          handed.pathname.replace(/\d+\.jpg$/, '1.jpg'),
          // The same second of another video.
          handed.pathname.replace(`/videos/${video}/`, `/videos/${other}/`)
        ]) {
          const response = await fetch(`${f.h.origin}${path}${handed.search}`, {
            redirect: 'manual'
          })
          expect(response.status, path).equals(403)
        }
        // A game's poster is held to its own second the same way.
        const detail = await call(`/games/${game}`, viewer())
        const poster = new URL(detail.body.videos[0].posterUrl, f.h.origin)
        const moved = poster.pathname.replace(
          /(\d+)\.jpg$/,
          (_, n: string) => `${Number(n) + 1}.jpg`
        )
        const refused = await fetch(`${f.h.origin}${moved}${poster.search}`, {
          redirect: 'manual'
        })
        expect(refused.status).equals(403)
        // A member's URL for the same still still answers.
        const mine = await call(`/videos/${video}/highlights`, member)
        const kept = await fetch(
          `${f.h.origin}${mine.body.highlights[0].stillUrl}`,
          {
            redirect: 'manual'
          }
        )
        expect(kept.status).equals(302)
      })

      it('withholds playback and the still route', async function () {
        for (const path of [
          `/videos/${video}/playback`,
          `/videos/${video}/still?t=60`
        ]) {
          const { status, body } = await call(path, viewer())
          expect(status, path).equals(403)
          expect(body).deep.equals(MEMBERS_ONLY)
        }
      })

      it('reads the away team’s game the same way', async function () {
        const { status, body } = await call(`/games/${f.games[1].id}`, viewer())
        expect(status).equals(200)
        expect(body.nonMemberView).equals(true)
      })

      it('still reads a season page as everybody does', async function () {
        const { status, body } = await call(`/seasons/${f.seasonA}`, viewer())
        expect(status).equals(200)
        expect(body.nonMemberView).equals(false)
      })
    })

  describe('for nobody signed in', function () {
    it('allows public highlight thumbnails without allowing playback', async function () {
      const { status, body } = await call(`/videos/${video}/highlights`, null)
      expect(status).equals(200)
      expect(body.highlights.length).greaterThan(0)
      const still = await fetch(`${f.h.origin}${body.highlights[0].stillUrl}`, {
        redirect: 'manual'
      })
      expect(still.status).equals(302)
      expect((await call(`/videos/${video}/playback`, null)).status).equals(401)
    })

    it('answers the public team page, not the non-member view', async function () {
      const { status, body } = await call(`/teams/${f.teamA}`, null)
      expect(status).equals(200)
      expect(body.nonMemberView).equals(false)
    })

    it('answers every private read 401', async function () {
      for (const path of [
        `/teams/${f.teamA}/roster`,
        `/teams/${f.teamA}/games`,
        `/teams/${f.teamA}/stats`,
        `/seasons/${f.seasonA}/standings`,
        `/games/${game}`,
        `/games/${game}/box-score`,
        `/videos/${video}/playback`,
        `/videos/${video}/still?t=60`
      ]) {
        const { status, body } = await call(path, null)
        expect(status, path).equals(401)
        expect(body.code, path).not.equals('membersOnly')
      }
    })
  })

  describe('for a member who also follows the team', function () {
    before(async function () {
      await f.h.db
        .insertInto('follows')
        .values({
          user_id: userIdOfGumbo(member),
          group_type: 'team',
          group_id: f.teamA
        })
        .execute()
    })

    it('never answers the non-member view', async function () {
      const team = await call(`/teams/${f.teamA}`, member)
      expect(team.body.nonMemberView).equals(false)
      expect(team.body.canViewPrivate).equals(true)

      const detail = await call(`/games/${game}`, member)
      expect(detail.body.nonMemberView).equals(false)
      expect(detail.body.linescore.home).deep.equals(side([2, 0, 4]))

      const roster = await call(`/teams/${f.teamA}/roster`, member)
      const avery = (
        roster.body as Array<{ userId: string; avatarUrl: string | null }>
      ).find(row => row.userId === userIdOfGumbo(f.players[0].id))
      expect(avery?.avatarUrl).to.be.a('string')
      // A member reads whom a family member is a guardian of.
      const guardian = (
        roster.body as Array<{ userId: string; guardianOf?: string[] }>
      ).find(row => row.userId === userIdOfGumbo(f.people.guardian))
      expect(guardian?.guardianOf).deep.equals(['Avery S'])

      for (const path of [
        `/teams/${f.teamA}/stats`,
        `/games/${game}/box-score`,
        `/videos/${video}/playback`
      ])
        expect((await call(path, member)).status, path).equals(200)
    })
  })

  describe('for a member of the team\u2019s season or league', function () {
    // Babe Ruth's counterpart over League B, on nothing of League A's.
    const watcher = 102

    const join = async (
      level: 'season' | 'league',
      id: string
    ): Promise<() => Promise<void>> => {
      if (level === 'season') {
        await f.h.db
          .insertInto('season_members')
          .values({
            id: 'smb_watcher',
            user_id: userIdOfGumbo(watcher),
            season_id: id
          })
          .execute()
        return async () => {
          await f.h.db
            .deleteFrom('season_members')
            .where('id', '=', 'smb_watcher')
            .execute()
        }
      }
      await f.h.db
        .insertInto('league_members')
        .values({
          id: 'lmb_watcher',
          user_id: userIdOfGumbo(watcher),
          league_id: id
        })
        .execute()
      return async () => {
        await f.h.db
          .deleteFrom('league_members')
          .where('id', '=', 'lmb_watcher')
          .execute()
      }
    }

    it('reads the team as a member does, never the non-member view', async function () {
      for (const [level, id] of [
        ['season', f.seasonA],
        ['league', f.leagueA]
      ] as const) {
        const leave = await join(level, id)
        try {
          const team = await call(`/teams/${f.teamA}`, watcher)
          expect(team.body.nonMemberView, level).equals(false)
          expect(team.body.canViewPrivate, level).equals(true)
          const detail = await call(`/games/${game}`, watcher)
          expect(detail.body.nonMemberView, level).equals(false)
          const roster = await call(`/teams/${f.teamA}/roster`, watcher)
          const avery = (
            roster.body as Array<{ userId: string; avatarUrl: string | null }>
          ).find(row => row.userId === userIdOfGumbo(f.players[0].id))
          expect(avery?.avatarUrl, level).to.be.a('string')
          for (const path of [
            `/teams/${f.teamA}/stats`,
            `/games/${game}/box-score`,
            `/videos/${video}/playback`
          ])
            expect(
              (await call(path, watcher)).status,
              `${level} ${path}`
            ).equals(200)
        } finally {
          await leave()
        }
      }
    })

    it('keeps the non-member view for a member of a season the team is not in', async function () {
      const leave = await join('season', f.playoffs)
      try {
        const team = await call(`/teams/${f.teamA}`, watcher)
        expect(team.body.nonMemberView).equals(true)
        expect(
          (await call(`/teams/${f.teamA}/stats`, watcher)).body
        ).deep.equals(MEMBERS_ONLY)
      } finally {
        await leave()
      }
    })
  })

  describe('for a team that is not there', function () {
    let merged: string

    before(async function () {
      merged = makeId('team')
      await f.h.db
        .insertInto('teams')
        .values({ id: merged, name: 'Demo Hawks (old)', merged_into: f.teamA })
        .execute()
    })

    it('answers 404, not the non-member view, for one merged into another or never made', async function () {
      for (const teamId of [merged, 'team-never-made'])
        for (const path of [
          `/teams/${teamId}/roster`,
          `/teams/${teamId}/games`,
          `/teams/${teamId}/stats`
        ]) {
          const { status, body } = await call(path, stranger)
          expect(status, path).equals(404)
          expect(body.code, path).not.equals('membersOnly')
        }
    })
  })
})
