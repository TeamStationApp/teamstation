import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { GameIntent } from '../../common/gameApprovals'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import type { ScoringAction } from '../../common/scoring/actions'
import { newSetup } from '../../common/scoring/lineup'
import { ScoringSession } from '../../common/scoring/session'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import type { Database } from '../db/database'
import { postGamePlays, readPlays } from '../events/postPlays'
import { lineupsAnswer } from '../events/teamLineups'
import { realClock } from '../groups/requests'
import { setScopeRoles } from '../invites/people'
import { eventRoutes } from './events'
import { gameApprovalRoutes } from './gameApprovals'

/** S15: a request that changed a game tells its scoreboard; no other does. */

/** The away leadoff, due up before the first pitch. */
async function awayLeadoff(
  database: Kysely<Database>,
  gameId: string
): Promise<number | null | undefined> {
  const game = await database
    .selectFrom('games')
    .select([
      'id',
      'home_team_id',
      'away_team_id',
      'currentPlay',
      'pregame',
      'lineups_digest'
    ])
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  return (await lineupsAnswer(database, game)).away.current?.batters[0]?.gumboId
}

describe('the game approval routes and the scoreboard', function () {
  this.timeout(60000)
  let f: GroupFixture
  const written: string[] = []
  beforeEach(async () => {
    written.length = 0
    // The harness mounts its own routes first: these, with the hook, answer
    // under their own prefix.
    f = await groupFixture(undefined, undefined, (app, { db }) => {
      app.use(
        '/api/v1/hooked',
        gameApprovalRoutes(db, realClock, {
          onGameWritten: gameId => {
            written.push(gameId)
          }
        })
      )
    })
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const intent = (): GameIntent => ({
    homeTeamId: f.teamB,
    awayTeamId: f.teamA,
    seasonId: f.seasonB,
    startAt: '2029-07-01T19:00:00.000Z',
    venue: 'Demo Field',
    outsideTournament: null,
    status: 'scheduled'
  })
  const post = async (
    route: string,
    body: unknown,
    user: number
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await f.h.request('POST', `/hooked${route}`, body, user)
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>
    }
  }
  /** Settles a request: accepted at once, or by the other team's admin. */
  const settled = async (answer: {
    body: Record<string, unknown>
  }): Promise<string> => {
    if (answer.body.status === 'pending') {
      const accepted = await post(
        `/game-requests/${String(answer.body.id)}/accept`,
        {},
        101
      )
      expect(accepted.status).equals(200)
      expect(accepted.body.status).equals('accepted')
      return String(accepted.body.gameId)
    }
    expect(answer.body.status).equals('accepted')
    return String(answer.body.gameId)
  }
  /** A Game Settings proposal; `version` as read now unless given. */
  const proposeSwap = async (
    gameId: string,
    game: GameIntent,
    key: string,
    version?: string
  ): Promise<{
    status: number
    body: Record<string, unknown>
    version: string
  }> => {
    const expected =
      version ??
      (
        (await (
          await f.h.request(
            'GET',
            `/games/${gameId}/scheduling`,
            undefined,
            102
          )
        ).json()) as { version: string }
      ).version
    const answer = await post(
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonB },
        game,
        gameId,
        expected,
        idempotencyKey: key
      },
      102
    )
    return { ...answer, version: expected }
  }

  it('tells the scoreboard of an accepted swap, and of no new game or refused one', async function () {
    const created = await post(
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonB },
        game: intent(),
        idempotencyKey: 'hooked-new-game'
      },
      102
    )
    expect(created.status).equals(201)
    const gameId = await settled(created)
    // A new game is on no scoreboard yet.
    expect(written).deep.equals([])

    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(102),
      { admin: true, flags: [] },
      userIdOfGumbo(101)
    )
    const swapped = { ...intent(), homeTeamId: f.teamA, awayTeamId: f.teamB }
    const swap = await proposeSwap(gameId, swapped, 'hooked-swap')
    expect(swap.status).equals(201)
    expect(await settled(swap)).equals(gameId)
    expect(written).deep.equals([gameId])
    // The same request again, by its key, writes nothing and tells nothing.
    if (swap.body.status === 'accepted') {
      const replay = await proposeSwap(
        gameId,
        swapped,
        'hooked-swap',
        swap.version
      )
      expect(replay.body.id).equals(swap.body.id)
    } else {
      const repeat = await post(
        `/game-requests/${String(swap.body.id)}/accept`,
        {},
        101
      )
      expect(repeat.body.status).equals('accepted')
    }
    expect(written).deep.equals([gameId])

    // Once an at-bat is under way the swap back is refused, and told nowhere.
    await sql`update games set "currentPlay" = '{}'::jsonb where id = ${gameId}`.execute(
      f.h.db
    )
    written.length = 0
    const refused = await proposeSwap(gameId, intent(), 'hooked-swap-back')
    expect(refused.status).equals(409)
    expect(refused.body.message).equals(
      'Home and away can be swapped only before the first pitch'
    )
    expect(written).deep.equals([])
  })
})

/** S17: the scoring screen's swap, for whoever may score the game. */
describe('swapping home and away from the scoring screen', function () {
  this.timeout(60000)
  let f: GroupFixture
  const written: string[] = []
  beforeEach(async () => {
    written.length = 0
    f = await groupFixture(undefined, undefined, (app, { db }) => {
      app.use(
        '/api/v1/hooked',
        eventRoutes(db, {
          onGameWritten: gameId => {
            written.push(gameId)
          }
        })
      )
    })
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const intent = (): GameIntent => ({
    homeTeamId: f.teamB,
    awayTeamId: f.teamA,
    seasonId: f.seasonB,
    startAt: '2029-07-01T19:00:00.000Z',
    venue: 'Demo Field',
    outsideTournament: null,
    status: 'scheduled'
  })
  const json = async (response: Response): Promise<Record<string, unknown>> =>
    (await response.json()) as Record<string, unknown>
  /** A published game: proposed by the season, accepted by team A. */
  const published = async (key: string): Promise<string> => {
    const sent = await json(
      await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'season', id: f.seasonB },
          game: intent(),
          idempotencyKey: key
        },
        102
      )
    )
    const accepted = await json(
      await f.h.request(
        'POST',
        `/game-requests/${String(sent.id)}/accept`,
        {},
        101
      )
    )
    expect(accepted.status).equals('accepted')
    return String(accepted.gameId)
  }
  let players = 300
  /** Nine players a side saved as the scoring screen saves lineups, then `after`. */
  const saveLineups = async (
    gameId: string,
    after: ScoringAction[] = []
  ): Promise<void> => {
    const start = players
    players += 18
    await insertFixtureUsers(
      f.h.db,
      Array.from({ length: 18 }, (_, i) => ({
        id: start + i,
        legacyId: makeId('user'),
        display_name: `Player ${i + 1}`
      }))
    )
    const roster = (first: number): Parameters<typeof newSetup>[1]['away'] =>
      Array.from({ length: 9 }, (_, i) => ({
        userId: userIdOfGumbo(first + i),
        gumboId: first + i,
        shortName: `Player ${first + i}`,
        jersey: String(i + 1)
      }))
    const teams = {
      away: { id: f.teamA, name: 'A' },
      home: { id: f.teamB, name: 'B' }
    }
    const setup = newSetup(teams, {
      away: roster(start),
      home: roster(start + 9)
    })
    const session = await ScoringSession.open(
      {
        load: async () => ({
          plays: (await readPlays(f.h.db, gameId)).map(
            play => play.gumbo as GumboPlay
          ),
          currentPlay: (await row(gameId)).currentPlay as CurrentPlay | null
        }),
        save: async (_id, change) => {
          const posted = await postGamePlays(
            f.h.db,
            gameId,
            asPostEventsBody({
              ...change,
              mode: 'live',
              source: { system: 'teamstation' }
            })
          )
          return {
            plays: posted.plays.map(play => play.gumbo as GumboPlay),
            currentPlay: posted.currentPlay as CurrentPlay | null
          }
        }
      },
      gameId,
      { gamePk: gameId, teams, setup },
      { setTimer: () => null, clearTimer: () => undefined }
    )
    for (const action of [
      {
        type: 'lineup',
        kind: 'roster',
        setup,
        confirmed: ['away', 'home']
      } satisfies ScoringAction,
      ...after
    ])
      expect(session.apply(action).problems).deep.equals([])
    await session.flush()
    expect(session.problem).equals(null)
  }
  const row = async (
    gameId: string
  ): Promise<{
    home_team_id: string
    away_team_id: string
    currentPlay: unknown
  }> =>
    await f.h.db
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id', 'currentPlay'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
  /** The menu's swap, naming the sides the game has now unless told others. */
  const swap = async (
    gameId: string,
    user: number,
    read?: { homeTeamId: string; awayTeamId: string }
  ): Promise<Response> => {
    const game = await f.h.db
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id'])
      .where('id', '=', gameId)
      .executeTakeFirst()
    return await f.h.request(
      'POST',
      `/hooked/games/${gameId}/swap-sides`,
      read ?? {
        homeTeamId: game?.home_team_id ?? f.teamB,
        awayTeamId: game?.away_team_id ?? f.teamA
      },
      user
    )
  }
  /** 104 keeps team A's score; 103 coaches team A without scoring it. */
  const giveRoles = async (): Promise<void> => {
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(104),
      { admin: false, flags: ['scorekeeper'] },
      userIdOfGumbo(101)
    )
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(103),
      { admin: false, flags: ['coach'] },
      userIdOfGumbo(101)
    )
  }

  it('swaps a game with saved lineups for a scorekeeper of either team, and tells the scoreboard', async function () {
    const gameId = await published('menu-swap')
    await saveLineups(gameId)
    await giveRoles()
    const answer = await swap(gameId, 104)
    expect(answer.status).equals(200)
    expect(await json(answer)).deep.equals({
      homeTeamId: f.teamA,
      awayTeamId: f.teamB
    })
    const game = await row(gameId)
    expect([game.home_team_id, game.away_team_id]).deep.equals([
      f.teamA,
      f.teamB
    ])
    // Team B, away now, bats first.
    // No at-bat is stored before the first pitch; the away leadoff is up.
    expect(game.currentPlay).equals(null)
    expect(await awayLeadoff(f.h.db, gameId)).equals(players - 9)
    expect(written).deep.equals([gameId])

    // Sent again from the sides read before, as after a lost answer: the
    // game is already swapped, so nothing changes and nothing is told.
    const again = await swap(gameId, 104, {
      homeTeamId: f.teamB,
      awayTeamId: f.teamA
    })
    expect(again.status).equals(200)
    expect(await json(again)).deep.equals({
      homeTeamId: f.teamA,
      awayTeamId: f.teamB
    })
    expect(await row(gameId)).deep.equals(game)
    expect(written).deep.equals([gameId])

    // From sides the game never had: refused.
    const elsewhere = await swap(gameId, 104, {
      homeTeamId: f.teamA,
      awayTeamId: f.standaloneTeam
    })
    expect(elsewhere.status).equals(409)
    expect(await row(gameId)).deep.equals(game)
  })

  it('refuses whoever may not score the game, and a game that is not there', async function () {
    const gameId = await published('menu-swap-roles')
    await saveLineups(gameId)
    await giveRoles()
    const before = await row(gameId)
    // A coach of team A who does not keep its score.
    expect((await swap(gameId, 103)).status).equals(403)
    // Somebody who cannot see the game is told it is not there, as every
    // events route tells him; once a member of team A, he is refused.
    expect((await swap(gameId, 106)).status).equals(404)
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamA,
        user_id: userIdOfGumbo(106),
        role: 'member'
      })
      .execute()
    expect((await swap(gameId, 106)).status).equals(403)
    expect((await swap('gam_missing', 104)).status).equals(404)
    expect(await row(gameId)).deep.equals(before)
    expect(written).deep.equals([])
  })

  it('refuses after a pitch, and leaves a pending Game Settings proposal to be refused', async function () {
    await giveRoles()
    const pitched = await published('menu-swap-pitch')
    await saveLineups(pitched, [{ type: 'pitch', call: 'B' }])
    const before = await row(pitched)
    const refused = await swap(pitched, 104)
    expect(refused.status).equals(409)
    expect((await json(refused)).message).equals(
      'Home and away can be swapped only before the first pitch'
    )
    expect(await row(pitched)).deep.equals(before)
    expect(written).deep.equals([])

    // Scored elsewhere: final, with no play stored here.
    const final = await published('menu-swap-final')
    await f.h.db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', final)
      .execute()
    const finalBefore = await row(final)
    const finished = await swap(final, 104)
    expect(finished.status).equals(409)
    expect((await json(finished)).message).equals(
      'Home and away can be swapped only before the first pitch'
    )
    expect(await row(final)).deep.equals(finalBefore)
    expect(written).deep.equals([])

    const pending = await published('menu-swap-pending')
    await saveLineups(pending)
    const snapshot = await json(
      await f.h.request('GET', `/games/${pending}/scheduling`, undefined, 101)
    )
    const proposed = await json(
      await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'team', id: f.teamA },
          initiatingTeamId: f.teamA,
          game: { ...intent(), venue: 'Other Field' },
          gameId: pending,
          expected: snapshot.version,
          idempotencyKey: 'menu-swap-pending-venue'
        },
        101
      )
    )
    expect(proposed.status).equals('pending')
    expect((await swap(pending, 104)).status).equals(200)
    const accepted = await f.h.request(
      'POST',
      `/game-requests/${String(proposed.id)}/accept`,
      {},
      102
    )
    expect(accepted.status).equals(409)
    expect((await json(accepted)).message).equals(
      'This game changed. Propose a fresh revision.'
    )
    const game = await row(pending)
    expect([game.home_team_id, game.away_team_id]).deep.equals([
      f.teamA,
      f.teamB
    ])
  })
})
