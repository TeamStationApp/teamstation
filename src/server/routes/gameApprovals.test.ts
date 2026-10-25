import { expect } from 'chai'
import type { Kysely, Selectable } from 'kysely'
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
import { atomic } from '../db/atomic'
import type { Database, GamesTable } from '../db/database'
import { postGamePlays, readPlays } from '../events/postPlays'
import { lineupsAnswer } from '../events/teamLineups'
import {
  PLAYS_CHANGED,
  SCORED_ELSEWHERE,
  swapOrReset,
  WITHDRAWN_GAME
} from '../games/resetSwap'
import { SWAP_REFUSED } from '../games/swapSides'
import { realClock } from '../groups/requests'
import { setScopeRoles } from '../invites/people'
import { SCORER_SWAP_BEGUN } from '../schedule/gameApprovals'
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
      'lineups_digest',
      'play_generation'
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
    expect(refused.body.message).equals(SCORER_SWAP_BEGUN)
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
  /** What the scorer read and confirms: the sides, plays and generation. */
  const confirmed = async (
    gameId: string
  ): Promise<{
    homeTeamId: string
    awayTeamId: string
    playsDigest: string
    generation: number
  }> => {
    const game = await row(gameId)
    const read = await json(
      await f.h.request('GET', `/hooked/games/${gameId}/events`, undefined, 104)
    )
    return {
      homeTeamId: game.home_team_id,
      awayTeamId: game.away_team_id,
      playsDigest: String(read.playsDigest),
      generation: Number(read.generation)
    }
  }
  /** The game's events as a screen reads them. */
  const events = async (gameId: string): Promise<Record<string, unknown>> =>
    await json(
      await f.h.request('GET', `/hooked/games/${gameId}/events`, undefined, 104)
    )
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
    expect((await events(gameId)).swap).equals('swap')
    const answer = await swap(gameId, 104)
    expect(answer.status).equals(200)
    expect(await json(answer)).deep.equals({
      homeTeamId: f.teamA,
      awayTeamId: f.teamB,
      generation: 0,
      reset: { atBats: 0, innings: 0 }
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
      awayTeamId: f.teamB,
      generation: 0,
      reset: { atBats: 0, innings: 0 }
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

  it('refuses a reset its scorer did not confirm or a game scored elsewhere, and leaves a pending Game Settings proposal to be refused', async function () {
    await giveRoles()
    const pitched = await published('menu-swap-pitch')
    await saveLineups(pitched, [{ type: 'pitch', call: 'B' }])
    const before = await row(pitched)
    // As an app not yet updated sends it: no plays confirmed, so the swap
    // it knows, before the first pitch, is refused as it always was.
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
    const finished = await swap(final, 104, await confirmed(final))
    expect(finished.status).equals(409)
    expect((await json(finished)).message).equals(SCORED_ELSEWHERE)
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

  /** Two half-innings of strikeouts, then a ball to the 2nd's leadoff. */
  const twoHalves: ScoringAction[] = [
    ...Array.from({ length: 18 }, (): ScoringAction => ({
      type: 'pitch',
      call: 'C'
    })),
    { type: 'pitch', call: 'B' }
  ]
  const gameRow = async (gameId: string): Promise<Selectable<GamesTable>> =>
    await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
  const playCount = async (gameId: string): Promise<number> =>
    (await readPlays(f.h.db, gameId)).length

  it('resets a begun game and swaps it, keeping every play in its archive (S4)', async function () {
    await giveRoles()
    const gameId = await published('menu-reset')
    await saveLineups(gameId, twoHalves)
    const first = players - 18
    const stored = await readPlays(f.h.db, gameId)
    expect(stored).has.length(6)
    // A fielder added by hand, which the archive keeps too.
    await f.h.db
      .insertInto('event_players')
      .values({
        id: makeId('eventPlayer'),
        event_id: stored[0].id,
        gumbo_id: first + 9 + 5,
        team_id: f.teamB,
        role: 'fielder',
        position: 'SS'
      })
      .execute()
    const read = await confirmed(gameId)
    // A tag, which the archive keeps too: put on after the read, which
    // would drop it, for it names no play of the game.
    await sql`insert into event_tag_catalog (tag) values ('reset-kept') on conflict do nothing`.execute(
      f.h.db
    )
    await f.h.db
      .insertInto('event_tags')
      .values({
        game_id: gameId,
        target_id: 'play-0',
        at_bat_index: 0,
        event_index: null,
        tag: 'reset-kept',
        assigned_by: userIdOfGumbo(104)
      })
      .execute()
    const before = await gameRow(gameId)
    expect(before.status).equals('inProgress')

    const answer = await swap(gameId, 104, read)
    expect(answer.status).equals(200)
    expect(await json(answer)).deep.equals({
      homeTeamId: f.teamA,
      awayTeamId: f.teamB,
      generation: 1,
      reset: { atBats: 7, innings: 2 }
    })

    const archive = await f.h.db
      .selectFrom('game_play_archives')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(archive).deep.include({
      reason: 'resetSwap',
      home_team_id: f.teamB,
      away_team_id: f.teamA,
      status: 'inProgress',
      play_generation: 0,
      lineups_digest: before.lineups_digest
    })
    expect(
      (archive.plays as Array<{ id: string }>).map(play => play.id)
    ).deep.equals(stored.map(play => play.id))
    expect(archive.current_play).deep.equals(before.currentPlay)
    expect(archive.players).has.length(1)
    expect(archive.tags).deep.equals([
      {
        game_id: gameId,
        target_id: 'play-0',
        at_bat_index: 0,
        event_index: null,
        tag: 'reset-kept',
        assigned_by: userIdOfGumbo(104)
      }
    ])

    expect(await playCount(gameId)).equals(0)
    const left = await sql<{ n: number }>`select
        (select count(*) from event_tags where game_id = ${gameId})::int
        + (select count(*) from "eventCredits" c join events e on e.id = c."eventId"
            where e."gameId" = ${gameId})::int as n`.execute(f.h.db)
    expect(left.rows[0].n).equals(0)
    const after = await gameRow(gameId)
    expect(after).deep.include({
      home_team_id: f.teamA,
      away_team_id: f.teamB,
      status: 'scheduled',
      home_score: null,
      away_score: null,
      linescore: null,
      fence_distance_ft: null,
      lineup_started_at: null,
      currentPlay: null,
      play_generation: 1
    })
    expect(after.lineups_digest).not.equals(before.lineups_digest)
    // The lineups at the first pitch, by team: nothing after it.
    const pregame = after.pregame as {
      version: number
      setupBefore: { teams: Record<string, unknown> }
      actions: Array<{ type: string }>
    }
    expect(pregame.version).equals(3)
    expect(Object.keys(pregame.setupBefore.teams).sort()).deep.equals(
      [f.teamA, f.teamB].sort()
    )
    expect(pregame.actions.map(action => action.type)).deep.equals(['lineup'])
    // Team B, away now, bats first: its leadoff is due up.
    expect(await awayLeadoff(f.h.db, gameId)).equals(first + 9)
    const stats = await f.h.db
      .selectFrom('game_stats_state')
      .select('status')
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(stats.status).equals('pending')
    const audit = await f.h.db
      .selectFrom('audit_log')
      .selectAll()
      .where('entity_id', '=', gameId)
      .where('path', '=', '/games/:gameId/swap-sides')
      .execute()
    expect(audit).has.length(1)
    expect(audit[0].before).deep.include({ plays: 6, generation: 0 })
    expect(audit[0].after).deep.include({
      plays: 0,
      generation: 1,
      status: 'scheduled'
    })
    expect(written).deep.equals([gameId])

    // Sent again, as after a lost answer: already done, so nothing changes.
    const again = await f.h.request(
      'POST',
      `/hooked/games/${gameId}/swap-sides`,
      {
        homeTeamId: f.teamB,
        awayTeamId: f.teamA,
        playsDigest: 'the digest it confirmed',
        generation: 0
      },
      104
    )
    expect(await json(again)).deep.equals({
      homeTeamId: f.teamA,
      awayTeamId: f.teamB,
      generation: 1,
      reset: { atBats: 0, innings: 0 }
    })
    expect(await gameRow(gameId)).deep.equals(after)
    expect(written).deep.equals([gameId])
  })

  it('refuses a stale confirmation, and changes nothing (S5)', async function () {
    await giveRoles()
    const gameId = await published('menu-reset-stale')
    await saveLineups(gameId, [{ type: 'pitch', call: 'B' }])
    const read = await confirmed(gameId)
    // Another device's save lands after the scorer read the game.
    await sql`update games set "currentPlay" = jsonb_set("currentPlay", '{about,hasReview}', 'true')
      where id = ${gameId}`.execute(f.h.db)
    const before = await gameRow(gameId)
    for (const body of [
      read,
      { ...read, playsDigest: undefined },
      { ...(await confirmed(gameId)), generation: 1 }
    ]) {
      const refused = await swap(gameId, 104, body)
      expect(refused.status).equals(409)
      expect((await json(refused)).message).equals(PLAYS_CHANGED)
    }
    expect(await gameRow(gameId)).deep.equals(before)
    expect(written).deep.equals([])
  })

  it('resets a final game and keeps a cancelled one cancelled, and refuses a withdrawn game or plays scored elsewhere (S6)', async function () {
    await giveRoles()
    const final = await published('menu-reset-final')
    await saveLineups(final, twoHalves)
    await f.h.db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', final)
      .execute()
    expect((await events(final)).swap).equals('reset')
    expect((await swap(final, 104, await confirmed(final))).status).equals(200)
    expect(await gameRow(final)).deep.include({
      status: 'scheduled',
      play_generation: 1
    })

    const cancelled = await published('menu-reset-cancelled')
    await saveLineups(cancelled, twoHalves)
    await f.h.db
      .updateTable('games')
      .set({ status: 'cancelled', cancellation_reason: 'rain' })
      .where('id', '=', cancelled)
      .execute()
    expect(
      (await swap(cancelled, 104, await confirmed(cancelled))).status
    ).equals(200)
    expect(await gameRow(cancelled)).deep.include({
      status: 'cancelled',
      cancellation_reason: 'rain',
      play_generation: 1
    })

    const withdrawn = await published('menu-reset-withdrawn')
    await saveLineups(withdrawn, twoHalves)
    await f.h.db
      .updateTable('games')
      .set({
        status: 'cancelled',
        cancellation_reason: 'withdrawal',
        withdrawn_by_team_id: f.teamA,
        withdrawn_at: new Date()
      })
      .where('id', '=', withdrawn)
      .execute()
    const withdrawnBefore = await gameRow(withdrawn)
    const refused = await swap(withdrawn, 104, await confirmed(withdrawn))
    expect(refused.status).equals(409)
    expect((await json(refused)).message).equals(WITHDRAWN_GAME)
    expect(await gameRow(withdrawn)).deep.equals(withdrawnBefore)

    // Nor, before its first pitch, a withdrawn game swapped as an older app
    // swaps it, or with what the screen confirmed.
    const unbegun = await published('menu-swap-withdrawn-unbegun')
    await saveLineups(unbegun)
    await f.h.db
      .updateTable('games')
      .set({
        status: 'cancelled',
        cancellation_reason: 'withdrawal',
        withdrawn_by_team_id: f.teamA,
        withdrawn_at: new Date()
      })
      .where('id', '=', unbegun)
      .execute()
    expect((await events(unbegun)).swap).equals('withdrawn')
    const unbegunRead = await confirmed(unbegun)
    const unbegunBefore = await gameRow(unbegun)
    for (const body of [undefined, unbegunRead]) {
      const refusedUnbegun = await swap(unbegun, 104, body)
      expect(refusedUnbegun.status).equals(409)
      expect((await json(refusedUnbegun)).message).equals(WITHDRAWN_GAME)
    }
    expect(await gameRow(unbegun)).deep.equals(unbegunBefore)

    // A play TeamStation did not score: no record.
    const elsewhere = await published('menu-reset-elsewhere')
    await saveLineups(elsewhere, twoHalves)
    const [play] = await readPlays(f.h.db, elsewhere)
    const { teamStation: _record, ...imported } = play.gumbo as Record<
      string,
      unknown
    >
    await f.h.db
      .updateTable('events')
      .set({ gumbo: imported })
      .where('id', '=', play.id)
      .execute()
    const elsewhereBefore = await gameRow(elsewhere)
    // Nor a game made final elsewhere whose at-bat holds only the lineups
    // saved here: TeamStation scored nothing, and its final score stays.
    const lineupsOnly = await published('menu-reset-lineups-final')
    await saveLineups(lineupsOnly)
    const saved = await gameRow(lineupsOnly)
    await f.h.db
      .updateTable('games')
      .set({
        currentPlay: {
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          teamStation: saved.pregame
        },
        pregame: null,
        status: 'final',
        home_score: 4,
        away_score: 2
      })
      .where('id', '=', lineupsOnly)
      .execute()
    const lineupsRead = await confirmed(lineupsOnly)
    const lineupsBefore = await gameRow(lineupsOnly)
    const kept = await swap(lineupsOnly, 104, lineupsRead)
    expect(kept.status).equals(409)
    expect((await json(kept)).message).equals(SCORED_ELSEWHERE)
    expect(await gameRow(lineupsOnly)).deep.equals(lineupsBefore)
    // Nor one made final elsewhere with its lineups still before the first
    // pitch: the screens are told so, and both bodies are refused.
    const pregameFinal = await published('menu-swap-pregame-final')
    await saveLineups(pregameFinal)
    await f.h.db
      .updateTable('games')
      .set({ status: 'final', home_score: 3, away_score: 1 })
      .where('id', '=', pregameFinal)
      .execute()
    expect((await events(pregameFinal)).swap).equals('scoredElsewhere')
    const pregameRead = await confirmed(pregameFinal)
    const pregameBefore = await gameRow(pregameFinal)
    // An app not yet updated, which offers no reset, is told what it
    // always was.
    for (const [body, message] of [
      [undefined, SWAP_REFUSED],
      [pregameRead, SCORED_ELSEWHERE]
    ] as const) {
      const refusedFinal = await swap(pregameFinal, 104, body)
      expect(refusedFinal.status).equals(409)
      expect((await json(refusedFinal)).message).equals(message)
    }
    expect(await gameRow(pregameFinal)).deep.equals(pregameBefore)
    // Nor an at-bat in progress TeamStation did not score, alone.
    const outside = await published('menu-reset-outside')
    await f.h.db
      .updateTable('games')
      .set({
        currentPlay: {
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          playEvents: [{ isPitch: true, details: { code: 'B' } }]
        }
      })
      .where('id', '=', outside)
      .execute()
    const outsideRead = await confirmed(outside)
    const outsideBefore = await gameRow(outside)
    const atBat = await swap(outside, 104, outsideRead)
    expect(atBat.status).equals(409)
    expect((await json(atBat)).message).equals(SCORED_ELSEWHERE)
    expect(await gameRow(outside)).deep.equals(outsideBefore)
    const imports = await swap(elsewhere, 104, await confirmed(elsewhere))
    expect(imports.status).equals(409)
    expect((await json(imports)).message).equals(SCORED_ELSEWHERE)
    expect(await gameRow(elsewhere)).deep.equals(elsewhereBefore)
    expect(await playCount(elsewhere)).equals(6)
  })

  it('rewinds a game scored before its pregame lineups were kept to its first record (S7)', async function () {
    await giveRoles()
    const gameId = await published('menu-reset-older')
    await saveLineups(gameId, twoHalves)
    const [first] = await readPlays(f.h.db, gameId)
    await f.h.db
      .updateTable('games')
      .set({ pregame: null })
      .where('id', '=', gameId)
      .execute()
    expect((await swap(gameId, 104, await confirmed(gameId))).status).equals(
      200
    )
    const record = (first.gumbo as { teamStation: Record<string, unknown> })
      .teamStation
    const pregame = (await gameRow(gameId)).pregame as Record<string, unknown>
    expect(pregame.setupBefore).deep.equals(record.setupBefore)
    expect(pregame.actions).deep.equals(
      (record.actions as Array<{ type: string }>).filter(
        action => action.type === 'lineup'
      )
    )
    expect(await awayLeadoff(f.h.db, gameId)).equals(players - 9)
  })

  it('rolls the reset and the swap back together (S8)', async function () {
    await giveRoles()
    const gameId = await published('menu-reset-rollback')
    await saveLineups(gameId, twoHalves)
    const before = await gameRow(gameId)
    const read = await confirmed(gameId)
    let failed: unknown
    try {
      await atomic(f.h.db, async trx => {
        await swapOrReset(trx, gameId, userIdOfGumbo(104), read)
        throw new Error('a later step failed')
      })
    } catch (error) {
      failed = error
    }
    expect(String(failed)).contains('a later step failed')
    expect(await gameRow(gameId)).deep.equals(before)
    expect(await playCount(gameId)).equals(6)
    const archives = await f.h.db
      .selectFrom('game_play_archives')
      .select('id')
      .where('game_id', '=', gameId)
      .execute()
    expect(archives).deep.equals([])
  })

  it('resets for a scorekeeper of either team, and for no one else (S9)', async function () {
    await giveRoles()
    const gameId = await published('menu-reset-roles')
    await saveLineups(gameId, twoHalves)
    const read = await confirmed(gameId)
    const before = await gameRow(gameId)
    expect((await swap(gameId, 103, read)).status).equals(403)
    expect(await gameRow(gameId)).deep.equals(before)
    // Team B's administrator keeps its score.
    expect((await swap(gameId, 102, read)).status).equals(200)
    expect(await gameRow(gameId)).deep.include({ play_generation: 1 })
  })
})
