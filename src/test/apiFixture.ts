import type { Insertable } from 'kysely'

import { makeId } from '../common/ids'
import { userIdOfGumbo } from '../common/userId'
import { createSession } from '../server/auth/sessions'
import type { Database } from '../server/db/database'
import type { MountExtra } from './accountHarness'
import { type GuardianFixture, guardianFixture } from './guardianFixture'
import { insertFixtureUsers } from './insertFixtureUsers'

/**
 * `guardianFixture` with what the API key and GraphQL tests read besides: a
 * songkeeper of Demo Hawks, who may not see a full name, and stat lines.
 *
 * Alfonso Soriano (201) and Ben Chapman (202) have a line in each of the
 * Hawks' two final games, Ben pitching as well. Alfonso also played the one
 * game of Demo Comets, in Demo Playoffs, which nobody else here belongs to:
 * only he, his guardian and the site administrator may see that line.
 */
export interface ApiFixture extends GuardianFixture {
  /** Juan Pierre, songkeeper of Demo Hawks. */
  songkeeper: number
  /** The Comets' game, which only Alfonso's side may open. */
  cometsGame: string
}

const SONGKEEPER = 211

export async function apiFixture(
  webRoot?: string,
  bindHost?: string,
  mountExtra?: MountExtra
): Promise<ApiFixture> {
  const f = await guardianFixture(webRoot, bindHost, mountExtra)
  try {
    return await seed(f)
  } catch (error) {
    await f.h.close()
    throw error
  }
}

async function seed(f: GuardianFixture): Promise<ApiFixture> {
  const db = f.h.db
  await insertFixtureUsers(db, {
    id: userIdOfGumbo(SONGKEEPER),
    legacyId: `usr_api_${SONGKEEPER}`,
    display_name: 'Juan Pierre',
    first_name: 'Juan',
    last_name: 'Pierre',
    login_enabled: true,
    email: 'songkeeper@example.com',
    emailId: `email_api_${SONGKEEPER}`
  })
  f.h.tokens.set(
    SONGKEEPER,
    (await createSession(db, userIdOfGumbo(SONGKEEPER), 'api')).token
  )
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: userIdOfGumbo(SONGKEEPER),
      scope_type: 'team',
      scope_id: f.teamA,
      role: 'songkeeper',
      granted_by: userIdOfGumbo(101),
      granted_at: new Date()
    })
    .execute()
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: userIdOfGumbo(SONGKEEPER),
      team_id: f.teamA,
      role: 'member',
      is_player: false
    })
    .execute()

  const cometsGame = 'api-game-comets'
  await db
    .insertInto('games')
    .values({
      id: cometsGame,
      home_team_id: f.secondTeam,
      away_team_id: f.rookies,
      season_id: f.playoffs,
      start_at: new Date('2026-09-06T18:00:00Z'),
      venue: 'Demo Field',
      status: 'final',
      home_score: 4,
      away_score: 1,
      timezone: 'UTC'
    })
    .execute()

  const line = (
    gameId: string,
    gumboId: number,
    teamId: string,
    batting: { ab: number; h: number; hr?: number; bb?: number; k?: number },
    pitching?: { outs: number; k: number; er: number }
  ): Insertable<Database['game_player_stats']> => ({
    id: makeId('gamePlayerStats'),
    game_id: gameId,
    gumbo_id: gumboId,
    team_id: teamId,
    pa: batting.ab + (batting.bb ?? 0),
    ab: batting.ab,
    h: batting.h,
    singles: batting.h - (batting.hr ?? 0),
    hr: batting.hr ?? 0,
    bb: batting.bb ?? 0,
    k: batting.k ?? 0,
    r: batting.hr ?? 0,
    rbi: batting.hr ?? 0,
    ...(pitching == null
      ? {}
      : {
          pitch_bf: pitching.outs + 3,
          pitch_outs: pitching.outs,
          pitch_k: pitching.k,
          pitch_er: pitching.er,
          pitch_r: pitching.er,
          pitch_h: 3
        })
  })
  const [hawksHome, hawksAway] = f.games
  await db
    .insertInto('game_player_stats')
    .values([
      line(hawksHome.id, 201, f.teamA, { ab: 4, h: 3, hr: 1 }),
      line(
        hawksHome.id,
        202,
        f.teamA,
        { ab: 3, h: 0, k: 2, bb: 1 },
        {
          outs: 18,
          k: 7,
          er: 2
        }
      ),
      line(hawksAway.id, 201, f.teamA, { ab: 4, h: 1 }),
      line(
        hawksAway.id,
        202,
        f.teamA,
        { ab: 4, h: 2 },
        {
          outs: 12,
          k: 4,
          er: 3
        }
      ),
      line(cometsGame, 201, f.secondTeam, { ab: 3, h: 2, hr: 1 })
    ])
    .execute()

  return { ...f, songkeeper: SONGKEEPER, cometsGame }
}
