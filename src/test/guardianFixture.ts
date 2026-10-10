import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { makeId } from '../common/ids'
import type { Role } from '../common/roles'
import { createSession } from '../server/auth/sessions'
import { posterSecond } from '../server/media/posters'
import { stillKey } from '../server/media/stills'
import { mediaRoutes } from '../server/routes/media'
import { demoLocality, type GroupFixture, groupFixture } from './groupFixtures'

/**
 * The guardians-and-roles world, on `groupFixture`'s leagues, seasons and
 * teams, with the media routes mounted and stills already in the Space.
 *
 * Demo Hawks (`teamA`, in Demo Regular of Demo League A) has five players.
 * A guardian is linked to Avery, with no membership of his own. Demo Regular
 * has a coach; the team has a coach, an assistant and a scorekeeper, each a
 * member who does not play. A follower follows the team and belongs to
 * nothing. Two final games of the team each have a ready video in the Space
 * and credited plays, so highlights list, and every still those lists and the
 * schedule's posters point at is the checked-in `fixtures/still.jpg`: the
 * pages draw thumbnails without FFmpeg. A last user runs one standalone team
 * of their own, for Home. Avery also plays for Demo Comets, in Demo
 * Playoffs, which nobody else here belongs to.
 *
 * Users from `groupFixture`: 101 Babe Ruth (alex@example.com) created and
 * administers League A, its seasons and Demo Hawks; 105 is a site admin.
 * Every person here who signs in has a session in `h.tokens` and a verified
 * address, so `h.request(…, id)` acts as them and a browser can sign in by
 * code.
 */
export interface GuardianFixture extends GroupFixture {
  people: {
    /** Babe Ruth, administrator of the league, its season and the team. */
    admin: number
    /** José Alvarez, site administrator. */
    siteAdmin: number
    /** Mike Trout, coach of Demo Regular. */
    seasonCoach: number
    /** Ichiro, coach of Demo Hawks. */
    teamCoach: number
    /** Owen Pratt, assistant of Demo Hawks. */
    assistant: number
    /** Nora Quinn, scorekeeper of Demo Hawks. */
    scorekeeper: number
    /** Tim Raines, guardian of Avery. */
    guardian: number
    /** Grace Hill, who follows Demo Hawks. */
    follower: number
    /** Hank Moss, who runs Demo Rookies and nothing else. */
    oneTeam: number
  }
  players: GuardianPlayer[]
  emails: Record<number, string>
  /** Demo Rookies, Hank Moss's team. */
  rookies: string
  /**
   * Demo Comets, in Demo Playoffs, a second team Avery plays on (#9, P) and
   * nobody else does: the team a guardian gains through the child, and loses
   * when the child leaves it.
   */
  secondTeam: string
  games: Array<{ id: string; videoId: string }>
}

export interface GuardianPlayer {
  id: number
  first: string
  last: string
  jersey: string
  positions: string[]
}

interface Person {
  id: number
  first: string
  last: string
  email: string | null
}

export const guardianPlayers: GuardianPlayer[] = [
  {
    id: 201,
    first: 'Avery',
    last: 'Stone',
    jersey: '7',
    positions: ['SS', '2B']
  },
  {
    id: 202,
    first: 'Ben',
    last: 'Carter',
    jersey: '12',
    positions: ['P', '1B']
  },
  { id: 203, first: 'Cody', last: 'Diaz', jersey: '23', positions: ['C'] },
  {
    id: 204,
    first: 'Drew',
    last: 'Ellis',
    jersey: '4',
    positions: ['CF', 'LF']
  },
  { id: 205, first: 'Eli', last: 'Fox', jersey: '15', positions: ['3B'] }
]

export async function guardianFixture(
  webRoot?: string,
  bindHost?: string
): Promise<GuardianFixture> {
  const f = await groupFixture(webRoot, bindHost, (app, { db, media }) => {
    app.use('/api/v1', mediaRoutes(db, media))
  })
  try {
    return await seed(f)
  } catch (error) {
    await f.h.close()
    throw error
  }
}

async function seed(f: GroupFixture): Promise<GuardianFixture> {
  const db = f.h.db
  const emails: Record<number, string> = {
    101: 'alex@example.com',
    103: 'fixture103@example.com',
    104: 'fixture104@example.com',
    105: 'fixture105@example.com',
    106: 'fixture106@example.com'
  }
  const adults: Person[] = [
    { id: 207, first: 'Grace', last: 'Hill', email: 'follower@example.com' },
    { id: 208, first: 'Hank', last: 'Moss', email: 'oneteam@example.com' },
    { id: 209, first: 'Nora', last: 'Quinn', email: 'scorekeeper@example.com' },
    { id: 210, first: 'Owen', last: 'Pratt', email: 'assistant@example.com' }
  ]
  const players = guardianPlayers.map(p => ({ ...p, email: null }))
  for (const p of [...players, ...adults]) {
    await db
      .insertInto('users')
      .values({
        id: p.id,
        legacyId: `usr_guardian_${p.id}`,
        display_name: `${p.first} ${p.last}`,
        first_name: p.first,
        last_name: p.last,
        login_enabled: p.email != null
      })
      .execute()
    if (p.email == null) continue
    emails[p.id] = p.email
    await db
      .insertInto('user_emails')
      .values({
        id: `email_guardian_${p.id}`,
        user_id: p.id,
        email: p.email,
        is_primary: true,
        verified_at: new Date(),
        source: 'manual'
      })
      .execute()
    f.h.tokens.set(p.id, (await createSession(db, p.id, 'guardian')).token)
  }

  for (const p of guardianPlayers)
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: p.id,
        team_id: f.teamA,
        role: 'member',
        is_player: true,
        jersey: p.jersey,
        positions: p.positions
      })
      .execute()

  await db
    .insertInto('user_links')
    .values({
      id: makeId('userLink'),
      user_id: 106,
      related_user_id: 201,
      kind: 'guardian',
      can_manage: true,
      created_at: new Date()
    })
    .execute()

  const role = async (
    userId: number,
    scopeType: 'league' | 'season' | 'team',
    scopeId: string,
    name: Role
  ): Promise<void> => {
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userId,
        scope_type: scopeType,
        scope_id: scopeId,
        role: name,
        granted_by: 101,
        granted_at: new Date()
      })
      .execute()
  }
  await role(103, 'season', f.seasonA, 'coach')
  await role(104, 'team', f.teamA, 'coach')
  await role(210, 'team', f.teamA, 'assistant')
  await role(209, 'team', f.teamA, 'scorekeeper')
  for (const userId of [104, 210, 209])
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: f.teamA,
        role: 'member',
        is_player: false
      })
      .execute()

  await db
    .insertInto('follows')
    .values({ user_id: 207, group_type: 'team', group_id: f.teamA })
    .execute()

  const created = await f.h.request(
    'POST',
    '/teams',
    {
      name: 'Demo Rookies',
      idempotencyKey: 'guardian-fixture-one-team',
      locality: demoLocality
    },
    208
  )
  if (created.status !== 201)
    throw new Error(`Demo Rookies: ${created.status} ${await created.text()}`)
  const rookies = ((await created.json()) as { id: string }).id

  const comets = await f.h.request(
    'POST',
    '/teams',
    {
      name: 'Demo Comets',
      idempotencyKey: 'guardian-fixture-second-team',
      locality: demoLocality,
      parent: { kind: 'season', id: f.playoffs }
    },
    101
  )
  if (comets.status !== 201)
    throw new Error(`Demo Comets: ${comets.status} ${await comets.text()}`)
  const secondTeam = ((await comets.json()) as { id: string }).id
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: 201,
      team_id: secondTeam,
      role: 'member',
      is_player: true,
      jersey: '9',
      positions: ['P']
    })
    .execute()

  const games = [
    {
      id: 'guardian-game-1',
      videoId: 'vid_guardian_1',
      home: f.teamA,
      away: f.standaloneTeam,
      startAt: new Date('2026-09-20T18:00:00Z'),
      homeScore: 6,
      awayScore: 3
    },
    {
      id: 'guardian-game-2',
      videoId: 'vid_guardian_2',
      home: f.teamB,
      away: f.teamA,
      startAt: new Date('2026-09-13T18:00:00Z'),
      homeScore: 2,
      awayScore: 5
    }
  ]
  for (const g of games) {
    await db
      .insertInto('games')
      .values({
        id: g.id,
        home_team_id: g.home,
        away_team_id: g.away,
        season_id: f.seasonA,
        start_at: g.startAt,
        venue: 'Demo Field',
        status: 'final',
        home_score: g.homeScore,
        away_score: g.awayScore,
        timezone: 'UTC'
      })
      .execute()
    await db
      .insertInto('videos')
      .values({
        id: g.videoId,
        game_id: g.id,
        kind: 'program',
        title: 'Demo game video',
        storage: 'spaces',
        status: 'ready',
        start_at: g.startAt,
        duration_sec: 7200
      })
      .execute()
  }
  const [avery, ben, cody] = guardianPlayers
  const plays = [
    {
      game: games[0],
      minutes: 12,
      player: avery,
      eventType: 'single',
      label: 'Single'
    },
    {
      game: games[0],
      minutes: 25,
      player: ben,
      eventType: 'strikeout',
      label: 'Strikeout'
    },
    {
      game: games[0],
      minutes: 41,
      player: avery,
      eventType: 'double',
      label: 'Double'
    },
    {
      game: games[0],
      minutes: 58,
      player: avery,
      eventType: 'home_run',
      label: 'Home run'
    },
    {
      game: games[1],
      minutes: 18,
      player: avery,
      eventType: 'triple',
      label: 'Triple'
    },
    {
      game: games[1],
      minutes: 33,
      player: cody,
      eventType: 'single',
      label: 'Single'
    }
  ]
  const indexes = new Map<string, number>()
  for (const play of plays) {
    const index = indexes.get(play.game.id) ?? 0
    indexes.set(play.game.id, index + 1)
    const at = new Date(
      play.game.startAt.getTime() + play.minutes * 60_000
    ).toISOString()
    const name = `${play.player.first} ${play.player.last[0]}`
    await db
      .insertInto('events')
      .values({
        id: `evt_guardian_${play.game.id}_${index}`,
        gameId: play.game.id,
        startTime: at,
        battingTeamId: f.teamA,
        gumbo: {
          about: {
            atBatIndex: index,
            inning: index + 1,
            halfInning: play.game.home === f.teamA ? 'bottom' : 'top',
            isScoringPlay: false,
            startTime: at
          },
          result: { eventType: play.eventType, awayScore: 0, homeScore: 0 },
          credits: [
            {
              eventType: play.eventType,
              label: `${play.label}: ${name}`,
              teamId: f.teamA,
              creditUserId: play.player.id,
              credit: { name, role: 'batter', position: null }
            }
          ]
        }
      })
      .execute()
  }

  // Every still a page will ask for, already in the Space: each video's
  // poster, and the moment of each of its highlights as the real route
  // works it out.
  const still = readFileSync(resolve(__dirname, 'fixtures/still.jpg'))
  const keep = (videoId: string, second: number): void => {
    f.h.objects.set(`/${f.h.space.bucket}/${stillKey(videoId, second)}`, still)
  }
  for (const g of games) {
    keep(g.videoId, posterSecond(7200))
    const answer = await f.h.request(
      'GET',
      `/videos/${g.videoId}/highlights`,
      undefined,
      105
    )
    if (answer.status !== 200)
      throw new Error(`Highlights of ${g.videoId}: ${answer.status}`)
    const { highlights } = (await answer.json()) as {
      highlights: Array<{ stillUrl: string }>
    }
    if (highlights.length === 0)
      throw new Error(`No highlights for ${g.videoId}`)
    for (const highlight of highlights) {
      const second = /\/stills\/(\d+)\.jpg/.exec(highlight.stillUrl)?.[1]
      if (second == null) throw new Error(`No still in ${highlight.stillUrl}`)
      keep(g.videoId, Number(second))
    }
  }

  return {
    ...f,
    people: {
      admin: 101,
      siteAdmin: 105,
      seasonCoach: 103,
      teamCoach: 104,
      assistant: 210,
      scorekeeper: 209,
      guardian: 106,
      follower: 207,
      oneTeam: 208
    },
    players: guardianPlayers,
    emails,
    rookies,
    secondTeam,
    games: games.map(g => ({ id: g.id, videoId: g.videoId }))
  }
}
