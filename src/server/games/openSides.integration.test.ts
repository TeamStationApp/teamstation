import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { GAME_SOCKET_PROTOCOL, PROTOCOL_HEADER } from '../../common/gameSocket'
import { makeId } from '../../common/ids'
import { OPEN_SIDE_NAME } from '../../common/openSides'
import {
  OPEN_SIDES_FEATURE,
  SCORING_FEATURE_HEADER,
  SCORING_FEATURES
} from '../../common/scoring/teamRecord'
import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { offlineScoringManifest } from '../scoring/offlineManifest'
import {
  fillOpenSides,
  OPEN_SIDES_FORBIDDEN,
  OPEN_SIDES_UPDATE
} from './openSides'

/** What an app that handles an open side names in its scoring features. */
const OPEN_APP = `${SCORING_FEATURES},${OPEN_SIDES_FEATURE}`

/**
 * The first scoring write on a game with an open side gives each open side
 * a placeholder team named TBD, and runs on the filled game. In the fixture,
 * 101 administers Demo Regular and Demo Hawks (a team under it), 103 Demo
 * Visitors (no season), 105 is a site administrator; 106 is made a
 * scorekeeper of Demo Regular with no team role, and 104 a player of Demo
 * Hawks, who sees its games and scores none.
 */
describe('the first scoring write on a game with an open side', function () {
  this.timeout(120000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
    // As every open-sides suite: the season's roles reach its teams through
    // `season_team_parents`.
    await f.h.db
      .insertInto('system_settings')
      .values({ key: 'creation.hierarchyReady', value: true })
      .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
      .execute()
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(106),
        scope_type: 'season',
        scope_id: f.seasonA,
        role: 'scorekeeper'
      })
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userIdOfGumbo(104),
        team_id: f.teamA,
        role: 'member',
        is_player: true,
        jersey: '7'
      })
      .execute()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  /** A game a day from now; `null` leaves a side open. */
  const insertGame = async (
    home: string | null,
    away: string | null,
    seasonId: string | null,
    extra: Record<string, unknown> = {}
  ): Promise<string> => {
    const id = makeId('game')
    const start = Date.now() + 24 * 3_600_000
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        season_id: seasonId,
        start_at: new Date(start),
        end_at: new Date(start + 2 * 3_600_000),
        timezone: 'UTC',
        venue: 'Demo Field',
        ...extra
      })
      .execute()
    return id
  }
  /** A request as the app sends it, naming `features` when given. */
  const send = async (
    method: string,
    path: string,
    body: unknown,
    user: number,
    features: string | null = OPEN_APP
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${f.h.origin}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${f.h.tokens.get(user)!}`,
        [PROTOCOL_HEADER]: String(GAME_SOCKET_PROTOCOL),
        ...(features == null ? {} : { [SCORING_FEATURE_HEADER]: features }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? undefined : JSON.parse(text)
    }
  }
  const gameRow = async (id: string): Promise<any> =>
    await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const teamCount = async (): Promise<number> =>
    (await f.h.db.selectFrom('teams').select('id').execute()).length
  const team = async (id: string): Promise<any> =>
    await f.h.db
      .selectFrom('teams')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const emptyLineup = async (
    gameId: string,
    side: 'home' | 'away',
    user: number,
    features: string | null = OPEN_APP
  ): Promise<{ status: number; body: any }> => {
    const read = await send('GET', `/games/${gameId}/lineups`, undefined, user)
    expect(read.status, JSON.stringify(read.body)).equals(200)
    return await send(
      'POST',
      `/games/${gameId}/lineups`,
      {
        side,
        base: read.body.digest,
        players: [],
        battingOrder: [],
        defense: {}
      },
      user,
      features
    )
  }
  const pitch = {
    about: {
      atBatIndex: 0,
      inning: 1,
      halfInning: 'top',
      isScoringPlay: false
    },
    count: { outs: 1 },
    result: {
      eventType: 'strikeout',
      awayScore: 0,
      homeScore: 0,
      description: 'Strikeout'
    },
    playEvents: [{ isPitch: true }]
  }
  const play = async (
    gameId: string,
    user: number,
    features: string | null = OPEN_APP
  ): Promise<{ status: number; body: any }> =>
    await send(
      'POST',
      `/games/${gameId}/events`,
      { plays: [pitch], source: { system: 'teamstation' } },
      user,
      features
    )
  /** A guest of Demo Hawks, made on a game of their own. */
  const hawksGuest = async (): Promise<{ userId: string; gumboId: number }> => {
    const scratch = await insertGame(f.teamA, f.standaloneTeam, null)
    const made = await send(
      'POST',
      `/games/${scratch}/guest-players`,
      {
        side: 'home',
        firstName: 'Babe',
        lastName: 'Ruth',
        jersey: '3',
        positions: [],
        bats: 'left',
        throws: null
      },
      101
    )
    expect(made.status, JSON.stringify(made.body)).equals(201)
    return made.body
  }

  /** Each scoring write, on a game whose home is Demo Hawks. */
  const writes: Record<
    string,
    (
      gameId: string,
      user: number,
      features?: string | null
    ) => Promise<{
      status: number
      body: any
    }>
  > = {
    lineups: async (gameId, user, features) =>
      await emptyLineup(gameId, 'away', user, features),
    'guest add': async (gameId, user, features) =>
      await send(
        'POST',
        `/games/${gameId}/guest-players`,
        {
          side: 'away',
          firstName: 'Lou',
          lastName: 'Gehrig',
          jersey: '4',
          positions: [],
          bats: 'left',
          throws: null
        },
        user,
        features
      ),
    'guest change': async (gameId, user, features) => {
      const guest = await hawksGuest()
      await f.h.db
        .updateTable('games')
        .set({ guests: { [f.teamA]: [guest.gumboId] } })
        .where('id', '=', gameId)
        .execute()
      return await send(
        'PUT',
        `/games/${gameId}/guest-players/${guest.userId}`,
        { firstName: 'George', lastName: 'Ruth' },
        user,
        features
      )
    },
    'external guest': async (gameId, user, features) =>
      await send(
        'POST',
        `/games/${gameId}/guests/external`,
        {
          guests: [
            {
              side: 'away',
              externalId: {
                system: 'outsideScorer',
                kind: 'player',
                id: `ext-${gameId}`
              },
              firstName: 'Cy',
              lastName: 'Young',
              jersey: '9'
            }
          ]
        },
        user,
        features
      ),
    unroster: async (gameId, user, features) =>
      await send(
        'PUT',
        `/games/${gameId}/unroster`,
        { side: 'home', userId: userIdOfGumbo(104), rostered: false },
        user,
        features
      ),
    plays: async (gameId, user, features) => await play(gameId, user, features),
    swap: async (gameId, user, features) =>
      await send(
        'POST',
        `/games/${gameId}/swap-sides`,
        { homeTeamId: f.teamA, awayTeamId: '' },
        user,
        features
      )
  }

  for (const [name, write] of Object.entries(writes))
    it(`fills the open side before a ${name} write, kept by the season`, async () => {
      const gameId = await insertGame(f.teamA, null, f.seasonA)
      const teams = await teamCount()
      const done = await write(gameId, 101)
      expect(done.status, JSON.stringify(done.body)).within(200, 201)
      expect(await teamCount()).equals(teams + 1)
      const game = await gameRow(gameId)
      const filled = name === 'swap' ? game.home_team_id : game.away_team_id
      expect(name === 'swap' ? game.away_team_id : game.home_team_id).equals(
        f.teamA
      )
      const made = await team(filled)
      expect(made).deep.include({
        name: OPEN_SIDE_NAME,
        kind: 'external',
        created_from: 'manual',
        custodian_type: 'season',
        custodian_id: f.seasonA
      })
      // Under the season, so its roles reach the placeholder; in no
      // standings, so no participant of it.
      expect(
        await f.h.db
          .selectFrom('season_team_parents')
          .select('season_id')
          .where('team_id', '=', filled)
          .execute()
      ).deep.equals([{ season_id: f.seasonA }])
      expect(
        await f.h.db
          .selectFrom('season_teams')
          .select('season_id')
          .where('team_id', '=', filled)
          .execute()
      ).deep.equals([])
      // A second write makes nothing more. (A play without a TeamStation
      // record ends the game, and a swap is tried again below.)
      if (name !== 'swap' && name !== 'plays') {
        const again = await play(gameId, 101)
        expect(again.status, JSON.stringify(again.body)).equals(200)
        expect(await teamCount()).equals(teams + 1)
      }
    })

  it('keeps a game with no season’s placeholder by its named team', async () => {
    const gameId = await insertGame(f.standaloneTeam, null, null)
    const done = await emptyLineup(gameId, 'away', 103)
    expect(done.status, JSON.stringify(done.body)).equals(200)
    const game = await gameRow(gameId)
    expect(game.home_team_id).equals(f.standaloneTeam)
    expect(await team(game.away_team_id)).deep.include({
      name: OPEN_SIDE_NAME,
      kind: 'external',
      custodian_type: 'team',
      custodian_id: f.standaloneTeam,
      league_id: null
    })
    expect(
      await f.h.db
        .selectFrom('season_team_parents')
        .select('season_id')
        .where('team_id', '=', game.away_team_id)
        .execute()
    ).deep.equals([])
  })

  it('lets a season scorekeeper fill both sides of a season game and score it', async () => {
    const gameId = await insertGame(null, null, f.seasonA)
    const teams = await teamCount()
    // He may start scoring it, so the read names him both sides.
    const first = await emptyLineup(gameId, 'home', 106)
    expect(first.status, JSON.stringify(first.body)).equals(200)
    expect(await teamCount()).equals(teams + 2)
    const game = await gameRow(gameId)
    expect(game.home_team_id).not.equals(game.away_team_id)
    for (const id of [game.home_team_id, game.away_team_id])
      expect(await team(id)).deep.include({
        name: OPEN_SIDE_NAME,
        custodian_type: 'season',
        custodian_id: f.seasonA
      })
    expect(first.body.home.teamId).equals(game.home_team_id)
    expect(first.body.away.teamId).equals(game.away_team_id)
    const second = await emptyLineup(gameId, 'away', 106)
    expect(second.status, JSON.stringify(second.body)).equals(200)
    const played = await play(gameId, 106)
    expect(played.status, JSON.stringify(played.body)).equals(200)
    expect(await teamCount()).equals(teams + 2)
  })

  it('swaps the filled sides, and refuses a later swap read before the fill', async () => {
    const gameId = await insertGame(f.teamA, null, f.seasonA)
    const swapped = await writes.swap(gameId, 101)
    expect(swapped.status, JSON.stringify(swapped.body)).equals(200)
    const game = await gameRow(gameId)
    expect(game.away_team_id).equals(f.teamA)
    expect(swapped.body).deep.include({
      homeTeamId: game.home_team_id,
      awayTeamId: f.teamA
    })
    expect((await team(game.home_team_id)).name).equals(OPEN_SIDE_NAME)
    const stale = await writes.swap(gameId, 101)
    expect(stale.status).equals(409)
    expect(stale.body.message).equals(
      "This game's teams changed. Open it again."
    )
    const after = await gameRow(gameId)
    expect([after.home_team_id, after.away_team_id]).deep.equals([
      game.home_team_id,
      f.teamA
    ])
  })

  it('refuses an app that cannot score an open side, and lets an API key', async () => {
    const gameId = await insertGame(f.teamA, null, f.seasonA)
    const teams = await teamCount()
    for (const features of [SCORING_FEATURES, null]) {
      const refused = await emptyLineup(gameId, 'away', 101, features)
      expect(refused.status, JSON.stringify(refused.body)).equals(503)
      expect(refused.body.message).equals(OPEN_SIDES_UPDATE)
      expect((await play(gameId, 101, features)).status).equals(503)
    }
    expect(await teamCount()).equals(teams)
    expect((await gameRow(gameId)).away_team_id).equals(null)
    // The same old app scores a game whose teams are named.
    const named = await insertGame(f.teamA, f.standaloneTeam, null)
    expect((await play(named, 101, SCORING_FEATURES)).status).equals(200)
    expect(await teamCount()).equals(teams)
    // An API key writes as it would, naming no features.
    const filled = await fillOpenSides(f.h.db, gameId, {
      ...actor(101),
      apiKey: { id: 'key', permissions: new Set() }
    })
    expect(filled?.before).deep.equals({ home: f.teamA, away: null })
    expect(filled?.after.home).equals(f.teamA)
    expect((await gameRow(gameId)).away_team_id).equals(filled?.after.away)
    expect(await teamCount()).equals(teams + 1)
    // Filled, it is no longer refused as needing an update.
    expect(await fillOpenSides(f.h.db, gameId, actor(101))).equals(undefined)
  })

  it('refuses whoever may not score it, and makes nothing', async () => {
    const gameId = await insertGame(f.teamA, null, f.seasonA)
    const teams = await teamCount()
    const refused = await emptyLineup(gameId, 'away', 104)
    expect(refused.status).equals(403)
    expect(refused.body.message).equals(OPEN_SIDES_FORBIDDEN)
    expect((await play(gameId, 104)).status).equals(403)
    // Somebody who cannot see it is told it is not there.
    expect((await writes['external guest'](gameId, 102)).status).equals(404)
    expect(await teamCount()).equals(teams)
    expect((await gameRow(gameId)).away_team_id).equals(null)
  })

  it('lets a coach who does not score fill it by saving his team’s lineup', async () => {
    // 102 coaches Demo Hawks and scores nothing.
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(102),
        scope_type: 'team',
        scope_id: f.teamA,
        role: 'coach'
      })
      .execute()
    const gameId = await insertGame(f.teamA, null, f.seasonA)
    const teams = await teamCount()
    // The open side's lineup is not his to save, so it fills nothing; nor
    // does any other write of his.
    expect((await emptyLineup(gameId, 'away', 102)).status).equals(403)
    expect((await play(gameId, 102)).status).equals(403)
    expect(await teamCount()).equals(teams)
    // Demo Hawks' lineup, which holds its one player, 104.
    const read = await send('GET', `/games/${gameId}/lineups`, undefined, 102)
    expect(read.status, JSON.stringify(read.body)).equals(200)
    const saved = await send(
      'POST',
      `/games/${gameId}/lineups`,
      {
        side: 'home',
        base: read.body.digest,
        players: [{ gumboId: 104, fullName: 'Ichiro', jersey: '7' }],
        battingOrder: [0],
        defense: {}
      },
      102
    )
    expect(saved.status, JSON.stringify(saved.body)).equals(200)
    expect(await teamCount()).equals(teams + 1)
    const game = await gameRow(gameId)
    expect(game.home_team_id).equals(f.teamA)
    expect((await team(game.away_team_id)).name).equals(OPEN_SIDE_NAME)
  })

  it('makes one placeholder of each side for two first writes at once', async () => {
    const gameId = await insertGame(null, null, f.seasonA)
    const teams = await teamCount()
    const [first, second] = await Promise.all([
      fillOpenSides(f.h.db, gameId, actor(105), undefined, OPEN_APP),
      fillOpenSides(f.h.db, gameId, actor(106), undefined, OPEN_APP)
    ])
    expect([first, second].filter(done => done != null)).length(1)
    expect(await teamCount()).equals(teams + 2)
  })

  it('leaves a game with both teams named as it is, for every write', async () => {
    const gameId = await insertGame(f.teamA, f.standaloneTeam, f.seasonA)
    const teams = await teamCount()
    for (const [name, write] of Object.entries(writes)) {
      if (name === 'swap' || name === 'plays') continue
      const done = await write(gameId, 105)
      expect(done.status, `${name}: ${JSON.stringify(done.body)}`).within(
        200,
        201
      )
    }
    // Swapped before the play, which ends the game.
    const swapped = await send(
      'POST',
      `/games/${gameId}/swap-sides`,
      { homeTeamId: f.teamA, awayTeamId: f.standaloneTeam },
      105
    )
    expect(swapped.status, JSON.stringify(swapped.body)).equals(200)
    expect((await writes.plays(gameId, 105)).status).equals(200)
    expect([
      (await gameRow(gameId)).home_team_id,
      (await gameRow(gameId)).away_team_id
    ]).deep.equals([f.standaloneTeam, f.teamA])
    // The guest change made a scratch game of Demo Hawks and Demo Visitors.
    expect(await teamCount()).equals(teams)
    expect(await fillOpenSides(f.h.db, gameId, actor(105))).equals(undefined)
  })

  it('names a season scorekeeper the named team of a game he may start scoring', async () => {
    // Demo Visitors is no team of Demo Regular, so 106 scores it only as
    // the scorer who may fill the game's open side.
    const gameId = await insertGame(f.standaloneTeam, null, f.seasonA)
    const read = await send('GET', `/games/${gameId}/events`, undefined, 106)
    expect(read.status, JSON.stringify(read.body)).equals(200)
    expect(read.body.halves).deep.equals([f.standaloneTeam])
    // His Game Settings may swap the game, and propose nothing.
    const both = await insertGame(null, null, f.seasonA)
    const scheduling = await send(
      'GET',
      `/games/${both}/scheduling`,
      undefined,
      106
    )
    expect(scheduling.status, JSON.stringify(scheduling.body)).equals(200)
    expect(scheduling.body).deep.include({
      canSwap: true,
      canPropose: false,
      withdrawTeamIds: []
    })
  })

  it('answers the lineups of a game with an open side', async () => {
    const gameId = await insertGame(f.teamA, null, f.seasonA)
    const read = await send('GET', `/games/${gameId}/lineups`, undefined, 101)
    expect(read.status, JSON.stringify(read.body)).equals(200)
    expect(read.body.away).deep.include({
      teamId: '',
      teamName: OPEN_SIDE_NAME
    })
    expect(read.body.away.current ?? null).equals(null)
    expect(read.body.home.teamId).equals(f.teamA)
    expect((await gameRow(gameId)).away_team_id).equals(null)
  })

  it('keeps a game with an open side off the phone until it is filled', async () => {
    const gameId = await insertGame(f.teamA, null, f.seasonA)
    const scorer = actor(106)
    const ids = async (): Promise<string[]> =>
      (await offlineScoringManifest(f.h.db, scorer)).games.map(game => game.id)
    expect(await ids()).not.include(gameId)
    await fillOpenSides(f.h.db, gameId, scorer, undefined, OPEN_APP)
    expect(await ids()).include(gameId)
  })
})
