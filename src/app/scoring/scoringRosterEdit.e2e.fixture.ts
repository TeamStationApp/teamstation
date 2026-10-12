import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { extname } from 'node:path'

import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import type { Role } from '../../common/roles'
import type { StoredGame } from '../../common/scoring/session'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import type { Database } from '../../server/db/database'
import { attachInt8Parser } from '../../server/db/int8'
import type { MediaContext } from '../../server/media/mediaContext'
import { withAudit } from '../../server/middleware/withAudit'
import { errorHandler } from '../../server/middleware/withErrors'
import { groupRoutes } from '../../server/routes/groups'
import { meRoutes } from '../../server/routes/me'
import { playerRoutes } from '../../server/routes/players'
import { teamRoutes } from '../../server/routes/teams'
import { POSITIONS } from './scoringTypes'

export interface RosterFixturePlayer {
  userId: number
  firstName: string
  lastName: string
  jersey: string | null
}

const people = [
  ['Mookie', 'Betts', '1'],
  ['Mike', 'Trout', '2'],
  ['Shohei', 'Ohtani', '3'],
  ['Aaron', 'Judge', '4'],
  ['Bryce', 'Harper', '5'],
  ['Freddie', 'Freeman', '6'],
  ['Francisco', 'Lindor', '7'],
  ['Juan', 'Soto', '12'],
  ['Bobby', 'Witt', '99'],
  ['Julio', 'Rodriguez', '100'],
  ['Adam', 'Duvall', null],
  ['Zack', 'Wheeler', null]
] as const
const ACTOR = 900

export interface RosterEditFixture {
  url: string
  gameId: string
  backendUrl: string
  players: (side: 'away' | 'home') => RosterFixturePlayer[]
  stored: () => StoredGame
  trace: string[]
  roles: (
    roles: readonly Role[],
    scope?: 'team' | 'season' | 'league',
    teams?: readonly string[]
  ) => Promise<void>
  rosterFailure: (enabled: boolean) => void
  saveFailure: (enabled: boolean) => void
  pauseWrites: (enabled: boolean) => void
  pauseSettings: (enabled: boolean, releasePending?: boolean) => void
  pauseRosterReads: (enabled: boolean, releasePending?: boolean) => void
  emptyRoster: (enabled: boolean) => void
  pauseSettingsResponses: (enabled: boolean, releasePending?: boolean) => void
  pauseRoleReads: (enabled: boolean) => void
  close: () => Promise<void>
}

const stop = async (server: Server): Promise<void> => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      error == null ? resolve() : reject(error)
    })
  })
}

/** Real roster/player authorization, isolated from the synthetic scoring log. */
export async function rosterEditFixture(
  assets: string,
  port: number
): Promise<RosterEditFixture> {
  assert(['localhost', '127.0.0.1'].includes(new URL(assets).hostname))
  assert(Number.isInteger(port) && port >= 0 && port < 65536)
  const name = `TeamStation_scoringRosterEdit_e2e_${Date.now()}_${randomBytes(4).toString('hex')}`
  const adminUrl =
    process.env.TS_TEST_DATABASE_URL ?? 'postgres://localhost:5433/postgres'
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  attachInt8Parser()
  const admin = new Pool({ connectionString: adminUrl })
  const disposers: Array<() => Promise<void>> = [
    async () => {
      await admin.end()
    }
  ]
  let closed = false
  const cleanup = async (): Promise<void> => {
    if (closed) return
    closed = true
    const errors: unknown[] = []
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Fixture cleanup failed')
  }
  try {
    await admin.query(`create database "${name}"`)
    disposers.push(async () => {
      await admin.query(`drop database "${name}"`)
    })
    const pool = new Pool({ connectionString: url.href })
    let endDatabase = async (): Promise<void> => {
      await pool.end()
    }
    disposers.push(async () => {
      await endDatabase()
    })
    await migrateUp(pool, migrations)
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    endDatabase = async () => {
      await db.destroy()
    }
    const rows = (side: 'away' | 'home'): RosterFixturePlayer[] =>
      people.map(([firstName, lastName, jersey], index) => ({
        userId: (side === 'away' ? 100 : 200) + index,
        firstName,
        lastName,
        jersey
      }))
    await db
      .insertInto('leagues')
      .values({ id: 'league_fixture', name: 'Fixture league' })
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: 'season_fixture',
        name: 'Fixture season',
        year: 2026,
        league_id: 'league_fixture'
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: 'away', name: 'Owls', league_id: 'league_fixture' },
        { id: 'home', name: 'Hawks', league_id: 'league_fixture' }
      ])
      .execute()
    await db
      .insertInto('season_team_parents')
      .values(
        ['away', 'home'].map(teamId => ({
          season_id: 'season_fixture',
          team_id: teamId
        }))
      )
      .execute()
    await db
      .insertInto('season_teams')
      .values(
        ['away', 'home'].map(teamId => ({
          season_id: 'season_fixture',
          team_id: teamId
        }))
      )
      .execute()
    await db
      .insertInto('users')
      .values([
        {
          id: ACTOR,
          login_enabled: true,
          legacyId: 'usr_fixture_scorer',
          display_name: 'Roster Scorer'
        },
        ...[...rows('away'), ...rows('home')].map(player => ({
          id: player.userId,
          legacyId: `usr_fixture_${player.userId}`,
          display_name: `${player.firstName} ${player.lastName}`,
          first_name: player.firstName,
          last_name: player.lastName,
          bats: 'right' as const,
          throws: 'right' as const
        }))
      ])
      .execute()
    for (const side of ['away', 'home'] as const) {
      await db
        .insertInto('memberships')
        .values(
          rows(side).map((player, index) => ({
            id: makeId('membership'),
            user_id: player.userId,
            team_id: side,
            is_player: true,
            jersey: player.jersey,
            positions: [POSITIONS[index % 9]]
          }))
        )
        .execute()
    }
    const roles = async (
      values: readonly Role[],
      scope: 'team' | 'season' | 'league' = 'team',
      teams: readonly string[] = ['away', 'home']
    ): Promise<void> => {
      await db.deleteFrom('scope_roles').where('user_id', '=', ACTOR).execute()
      if (values.length > 0)
        await db
          .insertInto('scope_roles')
          .values(
            (scope === 'team'
              ? teams
              : [scope === 'season' ? 'season_fixture' : 'league_fixture']
            ).flatMap(side =>
              values.map(role => ({
                id: makeId('scopeRole'),
                user_id: ACTOR,
                scope_type: scope,
                scope_id: side,
                role,
                granted_by: null,
                granted_at: new Date()
              }))
            )
          )
          .execute()
    }
    await roles(['scorekeeper'])
    const media: MediaContext = {
      mediaRoot: '',
      ffmpegPath: '',
      mediaSecret: randomBytes(32).toString('hex'),
      publicUrl: `http://localhost:${port}`,
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: ''
      }
    }
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      // Authentication is synthetic; operation permissions use the real database.
      req.actor = { userId: ACTOR, isAdmin: false, scopes: [] }
      next()
    })
    app.use(withAudit(db))
    app.use('/api/v1', meRoutes(db))
    app.use('/api/v1', playerRoutes(db, media))
    app.use('/api/v1', teamRoutes(db, media))
    app.use('/api/v1', groupRoutes(db, media))
    app.use(errorHandler)
    const backend = await new Promise<Server>((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => {
        resolve(server)
      })
      server.once('error', reject)
    })
    disposers.push(async () => {
      await stop(backend)
    })
    const address = backend.address()
    assert(address != null && typeof address !== 'string')
    const backendUrl = `http://127.0.0.1:${address.port}`
    const gameId = `roster${Date.now()}`
    const stored: StoredGame = { plays: [], currentPlay: null }
    const trace: string[] = []
    let rosterFailure = false
    let saveFailure = false
    let paused = false
    let pausedSettings = false
    let pausedRosters = false
    let emptyRoster = false
    let pausedSettingsResponses = false
    let pausedRoles = false
    const waiting = new Set<() => void>()
    const settingsWaiting = new Set<() => void>()
    const rosterWaiting = new Set<() => void>()
    const settingsResponseWaiting = new Set<() => void>()
    const roleWaiting = new Set<() => void>()
    const release = (waiting: Set<() => void>): void => {
      for (const resolve of waiting) resolve()
      waiting.clear()
    }
    const pauseWrites = (enabled: boolean): void => {
      paused = enabled
      if (!paused) {
        for (const resolve of waiting) resolve()
        waiting.clear()
      }
    }
    const server = createServer((req, res) => {
      const respond = async (): Promise<void> => {
        const u = new URL(req.url ?? '/', 'http://localhost')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization'
        )
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
        if (req.method === 'OPTIONS') {
          res.end()
          return
        }
        if (!u.pathname.startsWith('/api/')) {
          const path = extname(u.pathname) === '' ? '/' : u.pathname
          const response = await fetch(new URL(path, assets))
          res.statusCode = response.status
          res.setHeader(
            'Content-Type',
            response.headers.get('content-type') ?? ''
          )
          res.end(Buffer.from(await response.arrayBuffer()))
          return
        }
        res.setHeader('Content-Type', 'application/json')
        let body: unknown
        if (u.pathname === '/api/v1/auth/me')
          body = { id: ACTOR, displayName: 'Roster Scorer', isAdmin: false }
        else if (u.pathname === '/api/v1/me/notifications/summary')
          body = { hasPending: false }
        else if (u.pathname === '/api/v1/health')
          body = {
            status: 'ok',
            version: 'fixture',
            database: 'ok',
            migrations: 53,
            dictation: false
          }
        else if (/\/games\/[^/]+\/events$/.test(u.pathname)) {
          if (req.method === 'POST') {
            if (paused) await new Promise<void>(resolve => waiting.add(resolve))
            let text = ''
            for await (const chunk of req) text += String(chunk)
            const change = JSON.parse(text) as Partial<StoredGame> & {
              remove?: number[]
            }
            const plays = new Map(
              stored.plays.map(play => [play.about.atBatIndex, play])
            )
            for (const index of change.remove ?? []) plays.delete(index)
            for (const play of change.plays ?? [])
              plays.set(play.about.atBatIndex, play)
            stored.plays = [...plays.values()]
            if (change.currentPlay !== undefined)
              stored.currentPlay = change.currentPlay
          }
          body = {
            plays: stored.plays.map(play => ({
              id: `event${play.about.atBatIndex}`,
              gameId,
              gumbo: play
            })),
            currentPlay: stored.currentPlay
          }
        } else if (/\/games\/[^/]+$/.test(u.pathname))
          body = {
            id: gameId,
            awayTeamId: 'away',
            homeTeamId: 'home',
            awayTeamName: 'Owls',
            homeTeamName: 'Hawks',
            seasonId: null,
            startAt: null,
            venue: null,
            status: 'scheduled',
            homeScore: null,
            awayScore: null,
            ingestStatus: 'pending',
            ingestMessage: null,
            canScore: true,
            videos: []
          }
        else if (u.pathname.endsWith('/default-lineup')) {
          const side = u.pathname.includes('/away/') ? 'away' : 'home'
          const roster = rows(side)
          const person = (index: number): object => ({
            userId: roster[index].userId,
            name: `${roster[index].firstName} ${roster[index].lastName[0]}`,
            jersey: roster[index].jersey ?? ''
          })
          body = {
            lineup: {
              batters: roster.slice(0, 9).map((_, index) => person(index)),
              defense: Object.fromEntries(
                POSITIONS.map((position, index) => [position, person(index)])
              )
            },
            fromGameId: null,
            setAt: null
          }
        } else if (u.pathname.endsWith('/live-streams'))
          body = { gameId, mine: [], others: [], canAdd: 0, maxCameras: 3 }
        else {
          if (
            (rosterFailure && u.pathname.endsWith('/roster')) ||
            (saveFailure && req.method === 'PUT')
          ) {
            res.statusCode = 503
            res.end(
              JSON.stringify({
                code: 'unavailable',
                message: 'Fixture request temporarily unavailable'
              })
            )
            return
          }
          let text = ''
          for await (const chunk of req) text += String(chunk)
          if (req.method === 'PUT' && pausedSettings)
            await new Promise<void>(resolve => {
              trace.push(`Pending settings PUT ${u.pathname}`)
              settingsWaiting.add(resolve)
            })
          const response = await fetch(backendUrl + u.pathname + u.search, {
            method: req.method,
            ...(text === ''
              ? {}
              : { body: text, headers: { 'Content-Type': 'application/json' } })
          })
          const result = await response.text()
          if (req.method === 'PUT' && pausedSettingsResponses) {
            trace.push(`Captured settings PUT ${u.pathname}`)
            await new Promise<void>(resolve => {
              settingsResponseWaiting.add(resolve)
            })
          }
          if (u.pathname.endsWith('/me/roles') && pausedRoles) {
            trace.push('Captured roles GET')
            await new Promise<void>(resolve => {
              roleWaiting.add(resolve)
            })
          }
          // Hold a captured old read while a newer profile save finishes.
          if (
            req.method === 'GET' &&
            u.pathname.endsWith('/roster') &&
            pausedRosters
          ) {
            trace.push(`Captured roster GET ${u.pathname}${u.search}`)
            await new Promise<void>(resolve => {
              rosterWaiting.add(resolve)
            })
          }
          res.statusCode = response.status
          trace.push(
            `${req.method} ${u.pathname}${u.search}${text === '' ? '' : ` ${text}`} -> ${response.status} ${result}`
          )
          res.end(
            emptyRoster && response.ok && u.pathname.endsWith('/roster')
              ? '[]'
              : result
          )
          return
        }
        res.end(JSON.stringify(body))
      }
      respond().catch((error: unknown) => {
        trace.push(`Fixture error: ${String(error)}`)
        res.statusCode = 500
        res.end('{}')
      })
    })
    disposers.push(async () => {
      if (server.listening) await stop(server)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '0.0.0.0', resolve)
    })
    const edgeAddress = server.address()
    assert(edgeAddress != null && typeof edgeAddress !== 'string')
    return {
      url: `http://127.0.0.1:${edgeAddress.port}`,
      gameId,
      backendUrl,
      players: rows,
      stored: () => stored,
      trace,
      roles,
      rosterFailure: enabled => {
        rosterFailure = enabled
      },
      saveFailure: enabled => {
        saveFailure = enabled
      },
      pauseWrites,
      pauseSettings: (enabled, releasePending = true) => {
        pausedSettings = enabled
        if (!enabled && releasePending) release(settingsWaiting)
      },
      pauseRosterReads: (enabled, releasePending = true) => {
        pausedRosters = enabled
        if (!enabled && releasePending) release(rosterWaiting)
      },
      emptyRoster: enabled => {
        emptyRoster = enabled
      },
      pauseSettingsResponses: (enabled, releasePending = true) => {
        pausedSettingsResponses = enabled
        if (!enabled && releasePending) release(settingsResponseWaiting)
      },
      pauseRoleReads: enabled => {
        pausedRoles = enabled
        if (!enabled) release(roleWaiting)
      },
      close: async () => {
        pauseWrites(false)
        release(settingsWaiting)
        release(rosterWaiting)
        release(settingsResponseWaiting)
        release(roleWaiting)
        await cleanup()
      }
    }
  } catch (error: unknown) {
    await cleanup()
    throw error
  }
}
