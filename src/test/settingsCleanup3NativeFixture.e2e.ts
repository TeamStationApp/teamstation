import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import express from 'express'

import { googlePlaces } from '../server/location/googlePlaces'
import { healthRoutes } from '../server/routes/health'
import { googlePlacesStub } from './googlePlacesStub'
import { groupFixture } from './groupFixtures'
import { seedSettingsCleanup3 } from './settingsCleanup3Fixture'

/** Isolated real API/database/mail fixture, supplied explicitly per platform. */
async function main(): Promise<void> {
  const artifacts = process.env.TS_CREATION_ARTIFACTS
  const bind = process.env.TS_CREATION_NATIVE_HOST
  const host = process.env.TS_SETTINGS3_API_HOST
  if (artifacts == null || bind == null || host == null)
    throw new Error('Supply artifacts, native bind host and simulator API host')
  const branch = execFileSync('git', ['branch', '--show-current'], {
    encoding: 'utf8'
  }).trim()
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  if (branch !== 'paul/settingsCleanup3')
    throw new Error('Wrong settings QA branch')
  const stub = await googlePlacesStub()
  let fixture: Awaited<ReturnType<typeof groupFixture>> | undefined
  let api: Server | undefined
  let control: Server | undefined
  const close = async (): Promise<void> => {
    const errors: unknown[] = []
    for (const server of [control, api])
      if (server != null)
        try {
          await new Promise<void>((resolve, reject) => {
            server.close(error => {
              error == null ? resolve() : reject(error)
            })
            server.closeAllConnections()
          })
        } catch (error) {
          errors.push(error)
        }
    for (const dispose of [async () => await fixture?.h.close(), stub.close])
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    if (errors.length !== 0)
      throw new AggregateError(errors, 'Native fixture cleanup failed')
  }
  try {
    const f = await groupFixture(
      undefined,
      bind,
      undefined,
      googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl })
    )
    fixture = f
    await seedSettingsCleanup3(f)
    const app = express()
    app.use('/api/v1', healthRoutes(f.h.db, commit))
    // Keep returned synthetic object/API URLs reachable from this simulator.
    const reachable = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reachable)
      if (value != null && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, reachable(child)])
        )
      if (typeof value === 'string' && value.startsWith('http://')) {
        const url = new URL(value)
        if (
          ['127.0.0.1', 'localhost', '0.0.0.0', bind].includes(url.hostname)
        ) {
          url.hostname = host
          return url.href
        }
      }
      return value
    }
    app.use((req, res, next) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const headers = new Headers()
        for (const name of [
          'authorization',
          'content-type',
          'cookie',
          'range'
        ]) {
          const value = req.headers[name]
          if (typeof value === 'string') headers.set(name, value)
        }
        fetch(f.h.origin + req.originalUrl, {
          method: req.method,
          headers,
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) })
        })
          .then(async response => {
            res.status(response.status)
            const type = response.headers.get('content-type') ?? ''
            if (type.includes('application/json'))
              res.json(reachable(await response.json()))
            else {
              res.setHeader('content-type', type)
              res.end(Buffer.from(await response.arrayBuffer()))
            }
          })
          .catch(next)
      })
    })
    api = app.listen(0, bind)
    await new Promise<void>(resolve => api!.once('listening', resolve))
    const address = api.address()
    if (address == null || typeof address === 'string')
      throw new Error('Missing native API port')
    const controlApp = express()
    controlApp.use(express.json())
    controlApp.get('/code', (req, res) => {
      res.json({
        code:
          typeof req.query.email === 'string'
            ? (f.h.mail.get(req.query.email) ?? null)
            : null
      })
    })
    controlApp.get('/state', (_req, res, next) => {
      Promise.all([
        f.h.db
          .selectFrom('season_teams')
          .selectAll()
          .orderBy('season_id')
          .orderBy('team_id')
          .execute(),
        f.h.db
          .selectFrom('season_team_parents')
          .selectAll()
          .orderBy('season_id')
          .orderBy('team_id')
          .execute(),
        f.h.db.selectFrom('games').selectAll().orderBy('id').execute(),
        f.h.db.selectFrom('memberships').selectAll().orderBy('id').execute(),
        f.h.db
          .selectFrom('users')
          .select(['id', 'is_admin'])
          .orderBy('id')
          .execute(),
        f.h.db
          .selectFrom('teams')
          .select(['id', 'name', 'kind'])
          .orderBy('id')
          .execute()
      ])
        .then(([seasons, parents, games, memberships, users, teams]) => {
          res.json({ seasons, parents, games, memberships, users, teams })
        })
        .catch(next)
    })
    controlApp.post('/reset-season', (_req, res, next) => {
      f.h.db
        .updateTable('season_teams')
        .set({ active: true })
        .where('team_id', '=', f.teamA)
        .where('season_id', '=', f.seasonA)
        .execute()
        .then(() => res.json({ ok: true }))
        .catch(next)
    })
    controlApp.post('/team-name', (req, res, next) => {
      if (typeof req.body.name !== 'string' || req.body.name.length > 120) {
        res.status(400).json({ error: 'Invalid fixture name' })
        return
      }
      f.h.db
        .updateTable('teams')
        .set({ name: req.body.name })
        .where('id', '=', f.teamA)
        .execute()
        .then(() => res.json({ ok: true }))
        .catch(next)
    })
    control = controlApp.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => control!.once('listening', resolve))
    const controlAddress = control.address()
    if (controlAddress == null || typeof controlAddress === 'string')
      throw new Error('Missing control port')
    const support = join(artifacts, 'support')
    await mkdir(support, { recursive: true })
    await writeFile(
      join(support, 'settings3-native-manifest.json'),
      JSON.stringify(
        {
          branch,
          commit,
          apiBaseUrl: `http://${host}:${address.port}/api/v1`,
          controlOrigin: `http://127.0.0.1:${controlAddress.port}`,
          email: 'alex@example.com',
          team: f.teamA,
          opponent: f.teamB,
          season: f.seasonA,
          playoffs: f.playoffs,
          league: f.leagueA,
          player: 104,
          adminCandidate: 106,
          game: 'gam_settings3_scheduled',
          live: 'gam_settings3_live',
          final: 'gam_settings3_final'
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
    console.log(
      'Owned synthetic native fixture ready; manifest saved privately.'
    )
    const stop = (): void => {
      process.stdin.emit('end')
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      for await (const line of createInterface({
        input: process.stdin,
        terminal: false
      }))
        if (line === 'quit') break
    } finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
  } finally {
    try {
      await close()
    } finally {
      process.stdin.destroy()
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
