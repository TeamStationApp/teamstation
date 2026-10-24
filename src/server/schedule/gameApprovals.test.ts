import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { asGameProposal, type GameIntent } from '../../common/gameApprovals'
import { asParentActions } from '../../common/groupLinks'
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
import {
  actor,
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import type { Database } from '../db/database'
import { postGamePlays, readPlays } from '../events/postPlays'
import { lineupsAnswer, storedLineupsDigest } from '../events/teamLineups'
import { applyParents, previewParents } from '../groups/relationships'
import { setScopeRoles } from '../invites/people'
import { withdrawFromGame } from './gameApprovals'

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

describe('approved games and shared schedule ownership', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  function game(seasonId: string | null = f.seasonB): GameIntent {
    return {
      homeTeamId: f.teamB,
      awayTeamId: f.teamA,
      seasonId,
      startAt: '2029-07-01T19:00:00.000Z',
      venue: 'Demo Field',
      outsideTournament: null,
      status: 'scheduled'
    }
  }
  it('resends a declined team-origin season proposal with only the replacement on both inviting schedules and preserved history', async () => {
    const sent = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        initiatingTeamId: f.teamA,
        game: { ...game(f.seasonA), homeTeamId: f.teamA, awayTeamId: f.teamB },
        idempotencyKey: 'demo-resend-original'
      },
      101
    )
    expect(sent.status).equals(201)
    const old = (await sent.json()) as { id: string }
    expect(
      (await f.h.request('POST', `/game-requests/${old.id}/decline`, {}, 102))
        .status
    ).equals(200)
    const resent = await f.h.request(
      'POST',
      `/game-requests/${old.id}/resend`,
      { idempotencyKey: 'demo-resend-replacement' },
      101
    )
    expect(resent.status).equals(201)
    const replacement = (await resent.json()) as { id: string }
    for (const [kind, id] of [
      ['season', f.seasonA],
      ['team', f.teamA]
    ]) {
      const entries = (await (
        await f.h.request(
          'GET',
          `/game-requests?scopeKind=${kind}&scopeId=${id}`,
          undefined,
          101
        )
      ).json()) as Array<{ requestId: string }>
      expect(entries.map(entry => entry.requestId)).deep.equals([
        replacement.id
      ])
    }
    const history = (await (
      await f.h.request('GET', `/me/notifications/${old.id}`, undefined, 101)
    ).json()) as { status: string }
    expect(history.status).equals('declined')
  })
  it('hides declined team-origin season proposals only from the selected inviting projection with its own current administrator', async () => {
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(106),
      { admin: true, flags: [] },
      userIdOfGumbo(101)
    )
    const create = async (key: string): Promise<string> => {
      const response = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'season', id: f.seasonA },
          initiatingTeamId: f.teamA,
          game: {
            ...game(f.seasonA),
            homeTeamId: f.teamA,
            awayTeamId: f.teamB
          },
          idempotencyKey: key
        },
        101
      )
      expect(response.status).equals(201)
      const { id } = (await response.json()) as { id: string }
      expect(
        (await f.h.request('POST', `/game-requests/${id}/decline`, {}, 102))
          .status
      ).equals(200)
      return id
    }
    const entries = async (
      kind: 'team' | 'season',
      id: string,
      user: number
    ): Promise<Array<{ requestId: string; canDelete: boolean }>> =>
      (await (
        await f.h.request(
          'GET',
          `/game-requests?scopeKind=${kind}&scopeId=${id}`,
          undefined,
          user
        )
      ).json()) as Array<{ requestId: string; canDelete: boolean }>
    const first = await create('projection-team-first')
    const initial = await entries('team', f.teamA, 106)
    expect(initial).length(1)
    expect(initial[0]).includes({ requestId: first, canDelete: true })
    expect(
      (await entries('season', f.seasonA, 101)).map(row => row.requestId)
    ).deep.equals([first])
    const teamDelete = `/game-requests/${first}/schedule-entry?scopeKind=team&scopeId=${f.teamA}`
    expect(
      (await f.h.request('DELETE', teamDelete, undefined, 106)).status
    ).equals(200)
    expect(
      (await f.h.request('DELETE', teamDelete, undefined, 106)).status
    ).equals(200)
    expect(await entries('team', f.teamA, 106)).length(0)
    expect(
      (await entries('season', f.seasonA, 101)).map(row => row.requestId)
    ).deep.equals([first])
    expect(
      (
        await f.h.request(
          'DELETE',
          `/game-requests/${first}/schedule-entry`,
          undefined,
          101
        )
      ).status
    ).equals(200)
    const second = await create('projection-season-first')
    expect(
      (
        await f.h.request(
          'DELETE',
          `/game-requests/${second}/schedule-entry?scopeKind=season&scopeId=${f.seasonA}`,
          undefined,
          101
        )
      ).status
    ).equals(200)
    expect(await entries('season', f.seasonA, 101)).length(0)
    expect(
      (await entries('team', f.teamA, 106)).map(row => row.requestId)
    ).deep.equals([second])
    expect(
      (
        await f.h.request(
          'DELETE',
          `/game-requests/${second}/schedule-entry?scopeKind=team&scopeId=${f.teamB}`,
          undefined,
          102
        )
      ).status
    ).equals(403)
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', second)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('declined')
  })
  it('allows an invited team to withdraw recorded consent while another team is still pending, without publishing a game', async () => {
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamB,
      userIdOfGumbo(101),
      { admin: true, flags: [] },
      userIdOfGumbo(102)
    )
    const id = await send(
      { ...game(f.seasonA), homeTeamId: f.teamB, awayTeamId: f.standaloneTeam },
      101,
      'pending-team-consent-withdraw'
    )
    const accepted = await f.h.request(
      'POST',
      `/game-requests/${id}/accept`,
      {},
      102
    )
    expect(accepted.status).equals(200)
    expect(await accepted.json()).property('status', 'pending')
    const item = (await (
      await f.h.request('GET', `/me/notifications/${id}`, undefined, 102)
    ).json()) as { canAct: boolean; canWithdraw: boolean }
    expect(item).includes({ canAct: false, canWithdraw: true })
    const withdrawn = await f.h.request(
      'POST',
      `/game-requests/${id}/withdraw`,
      {},
      102
    )
    expect(withdrawn.status).equals(200)
    expect(await withdrawn.json()).property('status', 'cancelled')
    const retry = await f.h.request(
      'POST',
      `/game-requests/${id}/withdraw`,
      {},
      102
    )
    expect(retry.status).equals(200)
    expect(await retry.json()).property('status', 'cancelled')
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(0)
  })
  it('lets an administrator of the sending season withdraw a proposal, and not a team that has not consented', async () => {
    const id = await send(game(), 102, 'sender-scope-withdraw')
    const refused = await f.h.request(
      'POST',
      `/game-requests/${id}/withdraw`,
      {},
      101
    )
    expect(refused.status).equals(403)
    const withdrawn = await f.h.request(
      'POST',
      `/game-requests/${id}/withdraw`,
      {},
      105
    )
    expect(withdrawn.status).equals(200)
    expect(await withdrawn.json()).property('status', 'cancelled')
  })
  async function send(
    intent = game(),
    user = 102,
    key = 'game-invitation-first'
  ): Promise<string> {
    const sender =
      intent.seasonId == null
        ? { kind: 'team', id: user === 101 ? f.teamA : f.teamB }
        : { kind: 'season', id: intent.seasonId }
    const response = await f.h.request(
      'POST',
      '/game-requests',
      { sender, game: intent, idempotencyKey: key },
      user
    )
    expect(response.status, await response.clone().text()).equals(201)
    return ((await response.json()) as { id: string }).id
  }
  async function accept(
    id: string,
    user = 101
  ): Promise<{ id: string; status: string; gameId: string | null }> {
    const response = await f.h.request(
      'POST',
      `/game-requests/${id}/accept`,
      {},
      user
    )
    expect(response.status, await response.clone().text()).equals(200)
    return (await response.json()) as {
      id: string
      status: string
      gameId: string | null
    }
  }
  it('requires participant authority, accepts a raw nonmember guest outside reference dates and publishes one shared ID', async () => {
    const forbidden = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: game(),
        idempotencyKey: 'member-cannot-propose'
      },
      104
    )
    expect(forbidden.status).equals(403)
    const id = await send()
    expect(
      await f.h.db
        .selectFrom('games')
        .select('id')
        .where('season_id', '=', f.seasonB)
        .execute()
    ).length(0)
    const approved = await accept(id)
    expect(approved.status).equals('accepted')
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('team_id', '=', f.teamA)
        .execute()
    ).length(0)
    for (const route of [
      `/teams/${f.teamA}`,
      `/teams/${f.teamB}`,
      `/seasons/${f.seasonB}`
    ]) {
      const summary = (await (
        await f.h.request('GET', route, undefined, null)
      ).json()) as { games: Array<{ id: string }> }
      expect(summary.games.map(row => row.id)).includes(approved.gameId!)
    }
    expect((await accept(id)).gameId).equals(approved.gameId)
    expect(await send(game(), 102)).equals(id)
  })
  it('creates an outside game independently of all team parents and requires the other full team approval', async () => {
    const intent = { ...game(null), outsideTournament: 'Demo External Classic' }
    const id = await send(intent, 101)
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('pending')
    const approved = await accept(id, 102)
    const stored = await f.h.db
      .selectFrom('games')
      .select(['season_id', 'outside_tournament'])
      .where('id', '=', approved.gameId!)
      .executeTakeFirstOrThrow()
    expect(stored).deep.equals({
      season_id: null,
      outside_tournament: 'Demo External Classic'
    })
  })
  it('closes every task on decline and preserves a sender-only declined entry until scoped deletion', async () => {
    const id = await send(game(null), 101)
    expect(
      (await f.h.request('POST', `/game-requests/${id}/decline`, {}, 102))
        .status
    ).equals(200)
    const sender = (await (
      await f.h.request(
        'GET',
        `/game-requests?scopeKind=team&scopeId=${f.teamA}`,
        undefined,
        101
      )
    ).json()) as Array<{ requestId: string; status: string }>
    expect(sender).length(1)
    expect(sender[0]).property('status', 'declined')
    expect(
      await (
        await f.h.request(
          'GET',
          `/game-requests?scopeKind=team&scopeId=${f.teamB}`,
          undefined,
          102
        )
      ).json()
    ).deep.equals([])
    expect(
      (
        await f.h.request(
          'DELETE',
          `/game-requests/${id}/schedule-entry`,
          undefined,
          102
        )
      ).status
    ).equals(403)
    expect(
      (
        await f.h.request(
          'DELETE',
          `/game-requests/${id}/schedule-entry`,
          undefined,
          101
        )
      ).status
    ).equals(200)
    expect(
      await (
        await f.h.request(
          'GET',
          `/game-requests?scopeKind=team&scopeId=${f.teamA}`,
          undefined,
          101
        )
      ).json()
    ).deep.equals([])
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('declined')
    expect(
      (await f.h.request('GET', `/me/notifications/${id}`, undefined, 102))
        .status
    ).equals(200)
  })
  it('keeps the last approved game while a managed-original replacement requires only proposed participant consent', async () => {
    const published = await accept(await send())
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(102),
      { admin: true, flags: [] },
      userIdOfGumbo(101)
    )
    const snapshot = (await (
      await f.h.request(
        'GET',
        `/games/${published.gameId}/scheduling`,
        undefined,
        102
      )
    ).json()) as { version: string }
    const newGame = {
      ...game(),
      awayTeamId: f.standaloneTeam,
      venue: 'Demo Other Field'
    }
    const response = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonB },
        game: newGame,
        gameId: published.gameId,
        expected: snapshot.version,
        idempotencyKey: 'replace-guest-team'
      },
      102
    )
    expect(response.status).equals(201)
    const proposal = (await response.json()) as { id: string }
    expect(
      (
        await f.h.db
          .selectFrom('games')
          .select('away_team_id')
          .where('id', '=', published.gameId!)
          .executeTakeFirstOrThrow()
      ).away_team_id
    ).equals(f.teamA)
    expect((await accept(proposal.id, 103)).status).equals('accepted')
    expect(
      await f.h.db
        .selectFrom('games')
        .select(['away_team_id', 'venue'])
        .where('id', '=', published.gameId!)
        .executeTakeFirstOrThrow()
    ).deep.equals({ away_team_id: f.standaloneTeam, venue: 'Demo Other Field' })
  })
  // U8b: a head coach's lineup saved before the game begins names its
  // side's team, so the game keeps its teams, as after a scorer's.
  it('refuses to change the teams of a game whose lineup was saved before it began', async () => {
    const published = await accept(await send())
    await postGamePlays(
      f.h.db,
      published.gameId!,
      asPostEventsBody({
        mode: 'live',
        source: { system: 'teamstation' },
        plays: [],
        currentPlay: {
          about: {
            atBatIndex: 0,
            inning: 1,
            halfInning: 'top',
            isComplete: false
          },
          matchup: { batter: { fullName: 'Judge' } },
          playEvents: []
        }
      })
    )
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(102),
      { admin: true, flags: [] },
      userIdOfGumbo(101)
    )
    const snapshot = (await (
      await f.h.request(
        'GET',
        `/games/${published.gameId}/scheduling`,
        undefined,
        102
      )
    ).json()) as { version: string }
    const response = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonB },
        game: { ...game(), awayTeamId: f.standaloneTeam },
        gameId: published.gameId,
        expected: snapshot.version,
        idempotencyKey: 'replace-after-lineup'
      },
      102
    )
    expect(response.status).equals(409)
    expect(((await response.json()) as { message: string }).message).equals(
      'Keep played games on their original teams; use an administrative identity correction when necessary'
    )
    expect(
      await f.h.db
        .selectFrom('games')
        .select(['away_team_id', 'status'])
        .where('id', '=', published.gameId!)
        .executeTakeFirstOrThrow()
    ).deep.equals({ away_team_id: f.teamA, status: 'scheduled' })
  })
  describe('home and away swapped before the first pitch', function () {
    const SWAP_REFUSED =
      'Home and away can be swapped only before the first pitch'
    /** Nine players a side, saved as the scoring screen saves lineups. */
    async function saveLineups(
      gameId: string,
      after: ScoringAction[] = []
    ): Promise<void> {
      const known = await f.h.db
        .selectFrom('gumbo_ids')
        .select('gumbo_id')
        .where('gumbo_id', '=', 201)
        .executeTakeFirst()
      if (known == null)
        await insertFixtureUsers(
          f.h.db,
          Array.from({ length: 18 }, (_, i) => ({
            id: 201 + i,
            legacyId: makeId('user'),
            display_name: `Player ${i + 1}`
          }))
        )
      const roster = (start: number): Parameters<typeof newSetup>[1]['away'] =>
        Array.from({ length: 9 }, (_, i) => ({
          userId: userIdOfGumbo(start + i),
          gumboId: start + i,
          shortName: `Player ${start + i}`,
          jersey: String(start + i)
        }))
      const teams = {
        away: { id: f.teamA, name: 'A' },
        home: { id: f.teamB, name: 'B' }
      }
      const setup = newSetup(teams, { away: roster(201), home: roster(210) })
      const session = await ScoringSession.open(
        {
          load: async () => {
            const row = await f.h.db
              .selectFrom('games')
              .selectAll()
              .where('id', '=', gameId)
              .executeTakeFirstOrThrow()
            return {
              plays: (await readPlays(f.h.db, gameId)).map(
                play => play.gumbo as GumboPlay
              ),
              currentPlay: row.currentPlay as CurrentPlay | null,
              lineupsDigest: await storedLineupsDigest(f.h.db, row)
            }
          },
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
    /** Game Settings' swap, sent as a season administrator of both teams. */
    async function proposeSwap(gameId: string, key: string): Promise<Response> {
      await setScopeRoles(
        f.h.db,
        'team',
        f.teamA,
        userIdOfGumbo(102),
        { admin: true, flags: [] },
        userIdOfGumbo(101)
      )
      const snapshot = (await (
        await f.h.request('GET', `/games/${gameId}/scheduling`, undefined, 102)
      ).json()) as { version: string }
      return await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'season', id: f.seasonB },
          game: { ...game(), homeTeamId: f.teamA, awayTeamId: f.teamB },
          gameId,
          expected: snapshot.version,
          idempotencyKey: key
        },
        102
      )
    }
    const sides = async (
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

    it('swaps a game whose lineup was saved before it began', async () => {
      const published = await accept(await send())
      const gameId = published.gameId!
      await saveLineups(gameId)
      const response = await proposeSwap(gameId, 'swap-after-lineup')
      expect(response.status).equals(201)
      const request = (await response.json()) as { id: string; status: string }
      if (request.status === 'pending')
        expect((await accept(request.id)).status).equals('accepted')
      const game = await sides(gameId)
      expect([game.home_team_id, game.away_team_id]).deep.equals([
        f.teamA,
        f.teamB
      ])
      // The visitors' leadoff, now at home, waits; the hosts bat first.
      expect(await awayLeadoff(f.h.db, gameId)).equals(210)
    })

    it('refuses a swap of a game final with no play stored', async () => {
      const published = await accept(await send())
      const gameId = published.gameId!
      await f.h.db
        .updateTable('games')
        .set({ status: 'final' })
        .where('id', '=', gameId)
        .execute()
      const response = await proposeSwap(gameId, 'swap-final-elsewhere')
      expect(response.status).equals(409)
      expect(((await response.json()) as { message: string }).message).equals(
        SWAP_REFUSED
      )
      const game = await sides(gameId)
      expect([game.home_team_id, game.away_team_id]).deep.equals([
        f.teamB,
        f.teamA
      ])
    })

    it('refuses a swap after a pitch, and at acceptance once a pitch came in between', async () => {
      const published = await accept(await send())
      const gameId = published.gameId!
      await saveLineups(gameId, [{ type: 'pitch', call: 'B' }])
      const response = await proposeSwap(gameId, 'swap-after-pitch')
      expect(response.status).equals(409)
      expect(((await response.json()) as { message: string }).message).equals(
        SWAP_REFUSED
      )

      const other = await accept(
        await send(game(), 102, 'game-invitation-second')
      )
      const pendingId = other.gameId!
      await saveLineups(pendingId)
      // Proposed by one team's administrator, it waits for the other team.
      const snapshot = (await (
        await f.h.request(
          'GET',
          `/games/${pendingId}/scheduling`,
          undefined,
          101
        )
      ).json()) as { version: string }
      const proposed = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'team', id: f.teamA },
          initiatingTeamId: f.teamA,
          game: { ...game(), homeTeamId: f.teamA, awayTeamId: f.teamB },
          gameId: pendingId,
          expected: snapshot.version,
          idempotencyKey: 'swap-pending-pitch'
        },
        101
      )
      expect(proposed.status).equals(201)
      const pending = (await proposed.json()) as { id: string; status: string }
      expect(pending.status).equals('pending')
      const before = await sides(pendingId)
      await f.h.db
        .updateTable('games')
        .set({
          currentPlay: {
            ...(before.currentPlay as CurrentPlay),
            playEvents: [{ details: { code: 'B' } }]
          }
        })
        .where('id', '=', pendingId)
        .execute()
      const refused = await f.h.request(
        'POST',
        `/game-requests/${pending.id}/accept`,
        {},
        102
      )
      expect(refused.status).equals(409)
      expect(((await refused.json()) as { message: string }).message).equals(
        SWAP_REFUSED
      )
      const after = await sides(pendingId)
      expect([after.home_team_id, after.away_team_id]).deep.equals([
        f.teamB,
        f.teamA
      ])
    })
  })
  it('expires exactly at seven days, atomically resends and serializes racing acceptance with withdrawal', async () => {
    const id = await send()
    f.advance(7 * 24 * 3600 * 1000)
    expect((await accept(id)).status).equals('expired')
    const resend = await f.h.request(
      'POST',
      `/game-requests/${id}/resend`,
      { idempotencyKey: 'resend-expired-game' },
      102
    )
    expect(resend.status).equals(201)
    const next = (await resend.json()) as { id: string }
    const race = await Promise.all([
      f.h.request('POST', `/game-requests/${next.id}/accept`, {}, 101),
      f.h.request('POST', `/game-requests/${next.id}/withdraw`, {}, 102)
    ])
    expect(race[0].status).equals(200)
    expect([200, 409]).includes(race[1].status)
    expect(
      await f.h.db
        .selectFrom('games')
        .select('id')
        .where('season_id', '=', f.seasonB)
        .execute()
    ).length.at.most(1)
  })
  it('withdraws even a final game immediately and retains scores, attribution and historical rows; first committing team wins', async () => {
    const approved = await accept(await send())
    await f.h.db
      .updateTable('games')
      .set({ status: 'final', home_score: 8, away_score: 7 })
      .where('id', '=', approved.gameId!)
      .execute()
    const withdrawals = await Promise.all([
      withdrawFromGame(f.h.db, actor(101), approved.gameId!, f.teamA, f.clock),
      withdrawFromGame(f.h.db, actor(102), approved.gameId!, f.teamB, f.clock)
    ])
    expect(withdrawals[0].withdrawn_by_team_id).equals(
      withdrawals[1].withdrawn_by_team_id
    )
    const row = await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', approved.gameId!)
      .executeTakeFirstOrThrow()
    expect(row.status).equals('cancelled')
    expect(row.cancellation_reason).equals('withdrawal')
    expect(row.home_score).equals(8)
    expect(row.away_score).equals(7)
    expect([f.teamA, f.teamB]).includes(row.withdrawn_by_team_id!)
    expect(
      (
        await f.h.request(
          'POST',
          `/games/${approved.gameId}/withdrawals`,
          { teamId: f.standaloneTeam },
          103
        )
      ).status
    ).equals(403)
    const control = (await (
      await f.h.request(
        'GET',
        `/games/${approved.gameId}/scheduling`,
        undefined,
        101
      )
    ).json()) as { canPropose: boolean; withdrawTeamIds: string[] }
    expect(control.canPropose).equals(false)
    expect(control.withdrawTeamIds).includes(f.teamA)
    const proposal = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonB },
        game: game(),
        gameId: approved.gameId,
        expected: 'a'.repeat(64),
        idempotencyKey: 'cannot-resurrect'
      },
      102
    )
    expect(proposal.status).equals(409)
  })
  it('represents only an explicitly custodian-held external opponent and infers no membership', async () => {
    const external = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo External',
        external: true,
        custodian: { kind: 'season', id: f.seasonB },
        locality: demoLocality,
        idempotencyKey: 'game-external-stub'
      },
      102
    )
    const team = (await external.json()) as { id: string }
    const id = await send({ ...game(), awayTeamId: team.id })
    const request = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(request.status).equals('accepted')
    expect(request.game_id).not.equals(null)
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('team_id', '=', team.id)
        .execute()
    ).length(0)
  })
  it('invalidates pending placeholder consent after promotion while preserving the published game', async () => {
    const external = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Pending External',
        external: true,
        custodian: { kind: 'season', id: f.seasonB },
        locality: demoLocality,
        idempotencyKey: 'promotion-game-stub'
      },
      102
    )
    const stub = (await external.json()) as { id: string }
    const publishedId = await send(
      { ...game(), awayTeamId: stub.id },
      102,
      'published-external-game'
    )
    const pending = await send(
      { ...game(), homeTeamId: stub.id },
      102,
      'pending-external-game'
    )
    const promotion = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        sender: { kind: 'team', id: stub.id },
        kind: 'promotion',
        teamId: stub.id,
        recipientEmail: 'fixture103@example.com',
        idempotencyKey: 'promote-pending-stub'
      },
      102
    )
    expect(promotion.status).equals(201)
    const id = ((await promotion.json()) as { id: string }).id
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${id}/accept`,
          {},
          103
        )
      ).status
    ).equals(200)
    expect((await accept(pending, 101)).status).equals('pending')
    expect((await accept(pending, 103)).status).equals('accepted')
    const prior = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', publishedId)
      .executeTakeFirstOrThrow()
    expect(prior.status).equals('accepted')
    expect(prior.game_id).not.equals(null)
    expect(
      await f.h.db
        .selectFrom('games')
        .selectAll()
        .where('id', '=', prior.game_id!)
        .execute()
    ).length(1)
  })
  it('retains games after competition exit and parent unlink and permits the surviving direct team admin to withdraw', async () => {
    const id = await send()
    const approved = await accept(id)
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: f.seasonB, team_id: f.teamA })
      .execute()
    expect(
      (
        await f.h.request(
          'DELETE',
          `/seasons/${f.seasonB}/memberships/${f.teamA}`,
          undefined,
          101
        )
      ).status
    ).equals(200)
    const preview = await previewParents(
      f.h.db,
      asParentActions([
        {
          operation: 'detach',
          child: { kind: 'team', id: f.teamA },
          parent: { kind: 'league', id: f.leagueA }
        }
      ])
    )
    await applyParents(f.h.db, [actor(101)], preview)
    expect(
      (
        await f.h.db
          .selectFrom('games')
          .selectAll()
          .where('id', '=', approved.gameId!)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('scheduled')
    expect(
      (
        await withdrawFromGame(
          f.h.db,
          actor(101),
          approved.gameId!,
          f.teamA,
          f.clock
        )
      ).status
    ).equals('cancelled')
  })
  it('requires renewed hosting authorization after the proposing host loses authority, separately from team consent', async () => {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        scope_type: 'season',
        scope_id: f.seasonB,
        user_id: userIdOfGumbo(103),
        role: 'admin'
      })
      .execute()
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        scope_type: 'league',
        scope_id: f.leagueB,
        user_id: userIdOfGumbo(103),
        role: 'admin'
      })
      .execute()
    const id = await send()
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', userIdOfGumbo(102))
      .where('scope_id', 'in', [f.seasonB, f.leagueB, f.teamB])
      .execute()
    expect((await accept(id, 101)).status).equals('pending')
    const blocked = await f.h.request(
      'POST',
      `/game-requests/${id}/accept`,
      {},
      103
    )
    expect(blocked.status).equals(409)
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(0)
    const resent = await f.h.request(
      'POST',
      `/game-requests/${id}/resend`,
      { idempotencyKey: 'renewed-host-authorization' },
      103
    )
    expect(resent.status).equals(201)
    const replacement = await resent.json()
    expect(replacement.status).equals('pending')
    expect((await accept(replacement.id, 101)).status).equals('accepted')
  })
  it('validates explicit host, outside labels, opponents, timezone and material revision version', () => {
    const body = {
      sender: { kind: 'team', id: 'home' },
      game: {
        homeTeamId: 'home',
        awayTeamId: 'away',
        seasonId: null,
        startAt: '2027-04-01T10:00:00-07:00'
      },
      idempotencyKey: 'valid-game-intent'
    }
    expect(asGameProposal(body).game.startAt).equals('2027-04-01T17:00:00.000Z')
    for (const raw of [
      null,
      { ...body, sender: { kind: 'league', id: 'league' } },
      { ...body, game: { ...body.game, awayTeamId: 'home' } },
      { ...body, game: { ...body.game, startAt: '2027-04-01' } },
      { ...body, game: { ...body.game, startAt: '2027-02-29T17:00:00Z' } },
      { ...body, game: { ...body.game, seasonId: undefined } },
      {
        ...body,
        game: { ...body.game, seasonId: 'season', outsideTournament: 'Other' }
      },
      { ...body, gameId: 'game' }
    ])
      expect(() => asGameProposal(raw)).throws(TypeError)
  })
  it('does not deadlock a live scorer foreign-key lock while a proposal waits for the game', async () => {
    const published = await accept(await send())
    const scheduling = (await (
      await f.h.request(
        'GET',
        `/games/${published.gameId}/scheduling`,
        undefined,
        102
      )
    ).json()) as { version: string }
    let unlock!: () => void
    let ready!: () => void
    const held = new Promise<void>(resolve => {
      ready = resolve
    })
    const allowed = new Promise<void>(resolve => {
      unlock = resolve
    })
    const scorer = f.h.db.transaction().execute(async trx => {
      await trx
        .selectFrom('games')
        .select('id')
        .where('id', '=', published.gameId!)
        .forUpdate()
        .execute()
      ready()
      await allowed
      // Writing a scorer event acquires this foreign-key key-share lock.
      await sql`select id from users where id = ${102} for key share`.execute(
        trx
      )
    })
    await held
    const proposal = f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonB },
        game: { ...game(), venue: 'Demo Concurrent Field' },
        gameId: published.gameId,
        expected: scheduling.version,
        idempotencyKey: 'live-scorer-concurrency'
      },
      102
    )
    try {
      let waiting = false
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const blocked = await sql<{
          n: string
        }>`select count(*) as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query like '%games%'`.execute(
          f.h.db
        )
        waiting = Number(blocked.rows[0].n) > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).equals(true)
    } finally {
      unlock()
    }
    const [, response] = await Promise.all([scorer, proposal])
    expect(response.status, await response.clone().text()).equals(201)
  })
  it('keeps invalid requests, cutover gating and withdrawal retry responses explicit', async () => {
    expect(
      (await f.h.request('POST', '/game-requests', {}, 102)).status
    ).equals(400)
    const id = await send()
    expect(
      (await f.h.request('POST', `/game-requests/${id}/resend`, {}, 102)).status
    ).equals(400)
    expect(
      (await f.h.request('POST', `/game-requests/${id}/withdraw`, {}, 102))
        .status
    ).equals(200)
    expect(
      (await f.h.request('POST', `/game-requests/${id}/withdraw`, {}, 102))
        .status
    ).equals(200)
    const next = await send(game(), 102, 'withdrawal-http-game')
    const published = await accept(next)
    const response = await f.h.request(
      'POST',
      `/games/${published.gameId}/withdrawals`,
      { teamId: f.teamA },
      101
    )
    expect(response.status).equals(200)
    expect(await response.json()).deep.equals({
      id: published.gameId,
      status: 'cancelled',
      reason: 'withdrawal',
      withdrawnByTeamId: f.teamA
    })
    expect(
      (
        await f.h.request(
          'POST',
          `/games/${published.gameId}/withdrawals`,
          { teamId: f.teamA },
          101
        )
      ).status
    ).equals(200)
    await f.h.db
      .updateTable('system_settings')
      .set({ value: false })
      .where('key', '=', 'creation.hierarchyReady')
      .execute()
    expect(
      (
        await f.h.request(
          'GET',
          `/games/${published.gameId}/scheduling`,
          undefined,
          101
        )
      ).status
    ).equals(503)
  })
})
