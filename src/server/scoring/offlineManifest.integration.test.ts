import { randomUUID } from 'node:crypto'

import { expect } from 'chai'
import type { KyselyPlugin } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import type { Actor } from '../auth/sessions'
import { hasRecordedPlays, recordedPlaysOf } from '../replay/replayable'
import { offlineScoringManifest } from './offlineManifest'

const HOUR_MS = 3_600_000

describe('the games a phone keeps to score with no signal', function () {
  this.timeout(120000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const actorOf = (gumbo: number): Actor => ({
    userId: userIdOfGumbo(gumbo),
    isAdmin: gumbo === 105,
    scopes: []
  })
  const now = (): number => f.clock.now().getTime()
  async function grant(
    gumbo: number,
    scopeType: 'team' | 'season' | 'league',
    scopeId: string,
    role: 'scorekeeper' | 'admin' | 'coach' = 'scorekeeper'
  ): Promise<void> {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: randomUUID(),
        user_id: userIdOfGumbo(gumbo),
        scope_type: scopeType,
        scope_id: scopeId,
        role,
        granted_by: userIdOfGumbo(105)
      })
      .execute()
  }
  async function team(name: string): Promise<string> {
    const id = makeId('team')
    await f.h.db.insertInto('teams').values({ id, name }).execute()
    return id
  }
  async function game(
    home: string,
    away: string,
    hoursFromNow: number,
    more: {
      id?: string
      status?: 'scheduled' | 'inProgress' | 'final' | 'cancelled'
      homeScore?: number
      awayScore?: number
      cancellationReason?: string
    } = {}
  ): Promise<string> {
    const id = more.id ?? makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date(now() + hoursFromNow * HOUR_MS),
        status: more.status ?? 'scheduled',
        home_score: more.homeScore ?? null,
        away_score: more.awayScore ?? null,
        cancellation_reason: more.cancellationReason ?? null
      })
      .execute()
    return id
  }
  async function chosen(gumbo: number, held: string[] = []): Promise<string[]> {
    return (
      await offlineScoringManifest(f.h.db, actorOf(gumbo), held, f.clock)
    ).games.map(row => row.id)
  }

  it('keeps nothing for whoever only administers, coaches or watches, nor for a site administrator', async () => {
    const other = await team('Other')
    await game(f.teamA, other, 2)
    await game(other, f.teamA, 3)
    await grant(104, 'team', f.teamA, 'coach')
    expect(await chosen(101), 'the team’s administrator').deep.equals([])
    expect(await chosen(104), 'a coach').deep.equals([])
    expect(await chosen(105), 'a site administrator').deep.equals([])
    expect(await chosen(106), 'a spectator').deep.equals([])
    const empty = await offlineScoringManifest(
      f.h.db,
      actorOf(106),
      [],
      f.clock
    )
    expect(empty).deep.include({ games: [], nextBoundary: null })
  })

  it('takes the soonest three across every team a scorekeeper role reaches, team, season or league, either side, ties by id', async () => {
    const away = await team('Away')
    await grant(104, 'team', f.teamA)
    await grant(104, 'season', f.seasonB) // reaches teamB
    const third = await game(away, f.teamB, 30, { id: 'game_c' })
    const second = await game(f.teamA, away, 20, { id: 'game_b' })
    const tie = await game(away, f.teamA, 20, { id: 'game_a' })
    const fourth = await game(f.teamA, f.teamB, 50) // left out for 104
    expect(await chosen(104)).deep.equals([tie, second, third])
    // A league's role reaches its season's teams.
    await grant(106, 'league', f.leagueA)
    expect(await chosen(106)).deep.equals([tie, second, fourth])
    // An administrator who was also given the role keeps games.
    await grant(101, 'team', f.teamA)
    expect(await chosen(101)).deep.equals([tie, second, fourth])
  })

  it('counts a game on both of a scorekeeper’s teams once', async () => {
    await grant(104, 'team', f.teamA)
    await grant(104, 'team', f.teamB)
    const both = await game(f.teamA, f.teamB, 5)
    expect(await chosen(104)).deep.equals([both])
  })

  it('takes a start at now and just short of four days, and none from four days on', async () => {
    const away = await team('Away')
    await grant(104, 'team', f.teamA)
    const atNow = await game(f.teamA, away, 0)
    const inside = await game(f.teamA, away, 96 - 1 / 60)
    await game(f.teamA, away, 96)
    expect(await chosen(104)).deep.equals([atNow, inside])
  })

  it('leaves out cancelled, final, started, scored and rescheduled games, before the limit', async () => {
    const away = await team('Away')
    await grant(104, 'team', f.teamA)
    await game(f.teamA, away, 1, { status: 'cancelled' })
    await game(f.teamA, away, 2, { status: 'final' })
    await game(f.teamA, away, -1)
    await game(f.teamA, away, 3, { homeScore: 2, awayScore: 1 })
    await game(f.teamA, away, 4, { cancellationReason: 'rescheduled' })
    const first = await game(f.teamA, away, 5)
    const second = await game(f.teamA, away, 6)
    const third = await game(f.teamA, away, 7)
    await game(f.teamA, away, 8)
    expect(await chosen(104)).deep.equals([first, second, third])
  })

  it('keeps a held game for six hours after its start while it can still be scored, first, and never takes a started one anew', async () => {
    const away = await team('Away')
    await grant(104, 'team', f.teamA)
    const underWay = await game(f.teamA, away, -1)
    const long = await game(f.teamA, away, -7)
    const finished = await game(f.teamA, away, -2, { status: 'final' })
    const elsewhere = await game(f.teamA, away, -3, { homeScore: 3 })
    const recorded = await game(f.teamA, away, -4, { homeScore: 3 })
    await f.h.db
      .insertInto('events')
      .values({
        id: randomUUID(),
        gameId: recorded,
        startTime: null,
        endTime: null,
        battingTeamId: null,
        gumbo: JSON.stringify({
          about: { atBatIndex: 0 },
          teamStation: { v: 1 }
        }),
        titleOverride: null,
        createdAt: f.clock.now(),
        updatedAt: f.clock.now()
      })
      .execute()
    const soon = await game(f.teamA, away, 2)
    const later = await game(f.teamA, away, 3)
    expect(await chosen(104), 'none held').deep.equals([soon, later])
    expect(
      await chosen(104, [long, finished, elsewhere]),
      'past six hours, final, or scored elsewhere'
    ).deep.equals([soon, later])
    const manifest = await offlineScoringManifest(
      f.h.db,
      actorOf(104),
      [underWay, recorded],
      f.clock
    )
    expect(manifest.games.map(row => [row.id, row.started])).deep.equals([
      [recorded, true],
      [underWay, true],
      [soon, false]
    ])
  })

  it('reads past whole pages of games it cannot score, inside the window and past it', async () => {
    const away = await team('Away')
    await grant(104, 'team', f.teamA)
    // Seventeen games with a score begun, more than a page: the query
    // reads them, and none can be scored anew.
    for (let i = 0; i < 17; i++)
      await game(f.teamA, away, 1 + i / 60, { homeScore: 1 })
    const first = await game(f.teamA, away, 2)
    const second = await game(f.teamA, away, 3)
    expect(await chosen(104)).deep.equals([first, second])
    // Past the window too: the next to enter is behind a page of them.
    for (let i = 0; i < 17; i++)
      await game(f.teamA, away, 100 + i / 60, { homeScore: 1 })
    await game(f.teamA, away, 101)
    const short = await offlineScoringManifest(
      f.h.db,
      actorOf(104),
      [],
      f.clock
    )
    expect(Date.parse(short.nextBoundary!)).equals(now() + 2 * HOUR_MS)
    // With those two gone, the boundary is when that game enters.
    await f.h.db
      .deleteFrom('games')
      .where('id', 'in', [first, second])
      .execute()
    const none = await offlineScoringManifest(f.h.db, actorOf(104), [], f.clock)
    expect(none.games).deep.equals([])
    expect(Date.parse(none.nextBoundary!)).equals(now() + 5 * HOUR_MS)
  })

  it('names when the choice next changes: a start, a held game’s six hours, or the next game entering the window', async () => {
    const away = await team('Away')
    await grant(104, 'team', f.teamA)
    const far = await game(f.teamA, away, 120)
    const empty = await offlineScoringManifest(
      f.h.db,
      actorOf(104),
      [],
      f.clock
    )
    expect(empty.games).deep.equals([])
    expect(Date.parse(empty.nextBoundary!)).equals(now() + 24 * HOUR_MS)
    expect(far).not.equals(undefined)
    const soon = await game(f.teamA, away, 10)
    const one = await offlineScoringManifest(f.h.db, actorOf(104), [], f.clock)
    expect(one.games.map(row => row.id)).deep.equals([soon])
    expect(Date.parse(one.nextBoundary!)).equals(now() + 10 * HOUR_MS)
    const held = await game(f.teamA, away, -5)
    const kept = await offlineScoringManifest(
      f.h.db,
      actorOf(104),
      [held],
      f.clock
    )
    expect(Date.parse(kept.nextBoundary!)).equals(now() + 1 * HOUR_MS)
    expect(kept.digest).not.equals(one.digest)
    const again = await offlineScoringManifest(
      f.h.db,
      actorOf(104),
      [held],
      f.clock
    )
    expect(again.digest).equals(kept.digest)
    // Another opponent is other documents to keep.
    const other = await team('Other')
    await f.h.db
      .updateTable('games')
      .set({ away_team_id: other })
      .where('id', '=', held)
      .execute()
    const moved = await offlineScoringManifest(
      f.h.db,
      actorOf(104),
      [held],
      f.clock
    )
    expect(moved.digest, 'an opponent changed').not.equals(kept.digest)
  })

  it('answers the phone through GET /me/offline-scoring with each game’s schedule row, and nothing for a spectator', async () => {
    const away = await team('Away')
    await grant(104, 'team', f.teamA)
    const soon = await game(f.teamA, away, 4)
    const response = await f.h.request(
      'GET',
      `/me/offline-scoring?held=${soon}`,
      undefined,
      104
    )
    expect(response.status).equals(200)
    expect(response.headers.get('cache-control')).equals('no-store')
    const body = (await response.json()) as {
      games: Array<{ id: string; started: boolean; schedule: { id: string } }>
      nextBoundary: string
      digest: string
    }
    expect(body.games.map(row => [row.id, row.started])).deep.equals([
      [soon, false]
    ])
    expect(body.games[0].schedule).property('id', soon)
    expect(body.digest).a('string')
    const spectator = await f.h.request(
      'GET',
      '/me/offline-scoring',
      undefined,
      106
    )
    expect(await spectator.json()).deep.include({ games: [] })
  })

  it('reads a busy schedule in a bounded number of statements', async () => {
    const away = await team('Away')
    await grant(104, 'team', f.teamA)
    for (let i = 0; i < 320; i++)
      await game(i % 2 === 0 ? f.teamA : away, i % 2 === 0 ? away : f.teamA, i)
    let statements = 0
    const counter: KyselyPlugin = {
      transformQuery: args => {
        statements++
        return args.node
      },
      transformResult: async args => args.result
    }
    const counted = f.h.db.withPlugin(counter)
    const full = await offlineScoringManifest(
      counted,
      actorOf(104),
      [],
      f.clock
    )
    expect(full.games).length(3)
    const fullStatements = statements
    expect(fullStatements, 'a full manifest').lessThanOrEqual(20)
    statements = 0
    await offlineScoringManifest(counted, actorOf(106), [], f.clock)
    expect(statements, 'an empty manifest').lessThanOrEqual(8)
    // A proof run says the counts it held them to.
    if (process.env.TS_PROOF != null)
      process.stdout.write(
        `      320 games: ${fullStatements} statements for the scorer's three, ${statements} for a spectator's none\n`
      )
  })

  it('reads recorded plays for many games as hasRecordedPlays reads them one at a time', async () => {
    const away = await team('Away')
    const inProgress = await game(f.teamA, away, -1)
    const withPlay = await game(f.teamA, away, -2)
    const neither = await game(f.teamA, away, -3)
    const imported = await game(f.teamA, away, -4)
    await f.h.db
      .insertInto('events')
      .values([
        {
          id: randomUUID(),
          gameId: withPlay,
          startTime: null,
          endTime: null,
          battingTeamId: null,
          gumbo: JSON.stringify({
            about: { atBatIndex: 0 },
            teamStation: { v: 1 }
          }),
          titleOverride: null,
          createdAt: f.clock.now(),
          updatedAt: f.clock.now()
        },
        {
          id: randomUUID(),
          gameId: imported,
          startTime: null,
          endTime: null,
          battingTeamId: null,
          gumbo: JSON.stringify({
            about: { atBatIndex: 0 },
            result: { event: 'Single' }
          }),
          titleOverride: null,
          createdAt: f.clock.now(),
          updatedAt: f.clock.now()
        }
      ] as never)
      .execute()
    const games = [
      { id: inProgress, currentPlay: { teamStation: { at: 1 } } },
      { id: withPlay, currentPlay: null },
      { id: neither, currentPlay: { result: {} } },
      { id: imported, currentPlay: null }
    ]
    const many = await recordedPlaysOf(f.h.db, games)
    for (const one of games)
      expect(many.has(one.id), one.id).equals(
        await hasRecordedPlays(f.h.db, one.id, one.currentPlay)
      )
    expect([...many].sort()).deep.equals([inProgress, withPlay].sort())
  })
})
