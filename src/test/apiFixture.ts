import type { Insertable } from 'kysely'

import { makeId } from '../common/ids'
import { userIdOfGumbo } from '../common/userId'
import { createSession } from '../server/auth/sessions'
import type { Database } from '../server/db/database'
import type { PlateAppearance } from '../server/stats/plateAppearances'
import { writePlateAppearances } from '../server/statsBuilder/builder'
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

  // The plate appearances behind Alfonso's lines and Ben's pitching in the
  // Hawks' home game, and Alfonso's in the Comets' game: the state each
  // began in, and what came of it.
  const pa = (
    atBatIndex: number,
    batter: number | null,
    pitcher: number | null,
    battingTeamId: string,
    pitchingTeamId: string,
    state: {
      outs: number
      on?: Array<'1B' | '2B' | '3B'>
      first: 'ball' | 'strike' | 'inPlay'
    },
    result: Partial<PlateAppearance>
  ): PlateAppearance => ({
    isPa: true,
    atBatIndex,
    inning: 1 + atBatIndex,
    halfInning: battingTeamId === f.teamA ? 'bottom' : 'top',
    batterGumboId: batter,
    pitcherGumboId: pitcher,
    battingTeamId,
    pitchingTeamId,
    outsBefore: state.outs,
    onFirst: state.on?.includes('1B') ?? false,
    onSecond: state.on?.includes('2B') ?? false,
    onThird: state.on?.includes('3B') ?? false,
    firstPitch: state.first,
    pitches: 3,
    firstPitchThrown: state.first,
    pitchesThrown: 3,
    ab: 1,
    h: 0,
    singles: 0,
    doubles: 0,
    triples: 0,
    hr: 0,
    bb: 0,
    k: 0,
    hbp: 0,
    ci: 0,
    sf: 0,
    sh: 0,
    rbi: 0,
    outsMade: 0,
    ...result
  })
  const single = { h: 1, singles: 1 }
  const homer = { h: 1, hr: 1, rbi: 2 }
  const strikeout = { k: 1, outsMade: 1 }
  await writePlateAppearances(db, hawksHome.id, [
    pa(0, 201, null, f.teamA, f.teamB, { outs: 0, first: 'strike' }, single),
    pa(
      1,
      201,
      null,
      f.teamA,
      f.teamB,
      { outs: 2, on: ['2B'], first: 'ball' },
      homer
    ),
    pa(2, 201, null, f.teamA, f.teamB, { outs: 1, first: 'ball' }, strikeout),
    pa(
      3,
      201,
      null,
      f.teamA,
      f.teamB,
      { outs: 0, on: ['1B'], first: 'strike' },
      single
    ),
    pa(4, null, 202, f.teamB, f.teamA, { outs: 0, first: 'strike' }, strikeout),
    // Ben came in for this one at 1-0: the plate appearance is his, its
    // first pitch is not.
    {
      ...pa(
        5,
        null,
        202,
        f.teamB,
        f.teamA,
        { outs: 1, first: 'inPlay' },
        { outsMade: 1 }
      ),
      firstPitch: 'ball',
      firstPitchThrown: null,
      pitchesThrown: 2
    },
    pa(6, null, 202, f.teamB, f.teamA, { outs: 2, first: 'ball' }, strikeout),
    // Cody Decker comes in and picks a runner off: an out, and no batter.
    {
      ...pa(
        7,
        null,
        203,
        f.teamB,
        f.teamA,
        { outs: 2, on: ['1B'], first: 'ball' },
        { outsMade: 1 }
      ),
      isPa: false,
      ab: 0,
      firstPitch: null,
      pitches: 0,
      firstPitchThrown: null,
      pitchesThrown: 0
    },
    // Drew Ellis's run batted in on a strikeout charged to the man he
    // pinch-hit for: a row of its own.
    {
      ...pa(
        8,
        204,
        null,
        f.teamA,
        f.teamB,
        { outs: 0, first: 'ball' },
        { rbi: 1 }
      ),
      isPa: false,
      ab: 0,
      firstPitch: null,
      pitches: 0,
      firstPitchThrown: null,
      pitchesThrown: 0
    }
  ])
  await writePlateAppearances(db, cometsGame, [
    pa(
      0,
      201,
      null,
      f.secondTeam,
      f.rookies,
      { outs: 1, first: 'ball' },
      homer
    ),
    pa(
      1,
      201,
      null,
      f.secondTeam,
      f.rookies,
      { outs: 2, on: ['2B', '3B'], first: 'strike' },
      single
    ),
    pa(
      2,
      201,
      null,
      f.secondTeam,
      f.rookies,
      { outs: 0, first: 'strike' },
      strikeout
    )
  ])

  return { ...f, songkeeper: SONGKEEPER, cometsGame }
}
