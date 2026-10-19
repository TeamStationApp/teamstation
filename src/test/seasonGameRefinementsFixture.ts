import { createServer, request as proxyRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { makeId } from '../common/ids'
import { demoLocality, type GroupFixture, groupFixture } from './groupFixtures'

export interface RefinementsFixture {
  f: GroupFixture
  teams: Record<string, string>
  gameId: string
  managedGameId: string
  pendingId: string
  nativeProxy: Server
  nativePort: number
}

/** Deterministic synthetic result rows match the frozen predecessor proof. */
export async function refinementsFixture(
  webRoot: string,
  nativeBindHost: '127.0.0.1' | '0.0.0.0' = '127.0.0.1'
): Promise<RefinementsFixture> {
  const f = await groupFixture(webRoot)
  for (const [id, name] of [
    [101, 'Demo League Admin'],
    [102, 'Demo Opponent Admin'],
    [103, 'Demo Visitors Admin'],
    [104, 'Demo Child Player']
  ] as const)
    await f.h.db
      .updateTable('users')
      .set({ display_name: name, first_name: 'Demo', last_name: name.slice(5) })
      .where('id', '=', id)
      .execute()
  const teams: Record<string, string> = {
    Hawks: f.teamA,
    Eagles: f.teamB,
    Visitors: f.standaloneTeam
  }
  for (const name of ['Comets', 'Owls', 'Foxes', 'Unscheduled']) {
    const response = await f.h.request(
      'POST',
      '/teams',
      {
        name: `Demo ${name}`,
        idempotencyKey: `baseline-${name}`,
        locality: demoLocality,
        parent: { kind: 'season', id: f.seasonA }
      },
      101
    )
    if (response.status !== 201)
      throw new Error('Synthetic team fixture could not be created')
    teams[name] = (await response.json()).id
  }
  for (const id of [
    f.teamA,
    f.teamB,
    teams.Comets,
    teams.Owls,
    teams.Foxes,
    teams.Unscheduled
  ])
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: f.seasonA, team_id: id, active: true })
      .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
      .execute()
  await f.h.db
    .insertInto('memberships')
    .values({
      id: 'baseline-child-only-player',
      user_id: 104,
      team_id: teams.Comets,
      role: 'member',
      is_player: true
    })
    .execute()
  // Foxes remains the same opponent identity, now classified as a controlled placeholder.
  await f.h.db
    .updateTable('teams')
    .set({
      kind: 'external',
      custodian_type: 'season',
      custodian_id: f.seasonA
    })
    .where('id', '=', teams.Foxes)
    .execute()
  const results: Array<
    [string, string, string, string, number, number, boolean]
  > = [
    [
      'baseline-hawks-eagles',
      'Hawks',
      'Eagles',
      '2026-09-01T18:00:00Z',
      5,
      2,
      false
    ],
    [
      'baseline-eagles-hawks',
      'Eagles',
      'Hawks',
      '2026-09-05T18:00:00Z',
      4,
      4,
      false
    ],
    [
      'baseline-comets-hawks',
      'Comets',
      'Hawks',
      '2026-09-09T18:00:00Z',
      6,
      1,
      false
    ],
    [
      'baseline-owls-comets',
      'Owls',
      'Comets',
      '2026-09-12T18:00:00Z',
      2,
      7,
      false
    ],
    [
      'baseline-foxes-owls',
      'Foxes',
      'Owls',
      '2026-09-16T18:00:00Z',
      3,
      8,
      false
    ],
    [
      'baseline-hawks-visitors',
      'Hawks',
      'Visitors',
      '2026-09-20T18:00:00Z',
      7,
      0,
      true
    ]
  ]
  for (const [id, home, away, startAt, hs, as, exhibition] of results)
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: teams[home],
        away_team_id: teams[away],
        season_id: f.seasonA,
        start_at: new Date(startAt),
        venue: 'Demo Field',
        status: 'final',
        home_score: hs,
        away_score: as,
        exhibition,
        timezone: 'UTC'
      })
      .execute()
  const gameId = 'baseline-settings-game'
  const managedGameId = 'managed-settings-game'
  await f.h.db
    .insertInto('games')
    .values([
      {
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date('2026-10-15T18:30:00Z'),
        venue: 'Demo Field',
        status: 'scheduled'
      },
      {
        id: managedGameId,
        home_team_id: f.teamA,
        away_team_id: teams.Comets,
        season_id: f.seasonA,
        start_at: new Date('2026-10-16T18:30:00Z'),
        venue: 'Demo Managed Field',
        status: 'scheduled'
      }
    ])
    .execute()
  await f.h.db
    .insertInto('game_player_stats')
    .values({
      id: makeId('gamePlayerStats'),
      game_id: 'baseline-hawks-eagles',
      gumbo_id: 104,
      team_id: f.teamA,
      pa: 4,
      ab: 3,
      h: 2,
      singles: 1,
      doubles: 1,
      bb: 1,
      pitch_bf: 6,
      pitch_outs: 6,
      pitch_h: 1,
      pitch_bb: 1,
      pitch_er: 1
    })
    .execute()
  const pending = await f.h.request(
    'POST',
    '/game-requests',
    {
      sender: { kind: 'team', id: f.teamA },
      game: {
        homeTeamId: f.teamA,
        awayTeamId: f.standaloneTeam,
        seasonId: f.seasonA,
        startAt: '2026-10-18T18:00:00Z',
        venue: 'Demo Practice Field',
        outsideTournament: null,
        status: 'scheduled'
      },
      idempotencyKey: 'baseline-pending-proposal'
    },
    101
  )
  if (pending.status !== 201)
    throw new Error('Synthetic pending fixture could not be created')
  const pendingId = (await pending.json()).id
  const gameReads: string[] = []
  const nativeProxy = createServer((req, res) => {
    if (
      req.method === 'GET' &&
      req.url != null &&
      /^\/api\/v1\/games\/[^/?]+(?:\?.*)?$/.test(req.url)
    )
      gameReads.push(decodeURIComponent(req.url.split('/')[4].split('?')[0]))
    if (req.url?.startsWith('/__refinements/state') === true) {
      Promise.all([
        f.h.db
          .selectFrom('games')
          .select([
            'id',
            'home_team_id',
            'away_team_id',
            'status',
            'venue',
            'cancellation_reason',
            'withdrawn_by_team_id'
          ])
          .execute(),
        f.h.db
          .selectFrom('teams')
          .select(['id', 'name', 'kind', 'custodian_type', 'custodian_id'])
          .execute(),
        f.h.db
          .selectFrom('group_requests')
          .select(['id', 'status', 'game_id', 'terms'])
          .where('kind', '=', 'game')
          .execute()
      ])
        .then(([games, listedTeams, requests]) => {
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({ games, teams: listedTeams, requests, gameReads })
          )
        })
        .catch(() => {
          res.writeHead(500)
          res.end('Fixture inspection failed')
        })
      return
    }
    if (req.url?.startsWith('/__refinements/code') === true) {
      const email =
        new URL(req.url, 'http://localhost').searchParams.get('email') ?? ''
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: f.h.mail.get(email) ?? null }))
      return
    }
    const upstream = proxyRequest(
      new URL(req.url ?? '/', f.h.origin),
      { method: req.method, headers: req.headers },
      reply => {
        res.writeHead(reply.statusCode ?? 500, reply.headers)
        reply.pipe(res)
      }
    )
    upstream.on('error', () => {
      res.writeHead(502)
      res.end('Synthetic fixture unavailable')
    })
    req.pipe(upstream)
  })
  await new Promise<void>(resolve =>
    nativeProxy.listen(0, nativeBindHost, resolve)
  )
  return {
    f,
    teams,
    gameId,
    managedGameId,
    pendingId,
    nativeProxy,
    nativePort: (nativeProxy.address() as AddressInfo).port
  }
}
