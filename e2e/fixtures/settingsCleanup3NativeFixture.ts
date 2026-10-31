import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import express from 'express'

import { userIdOfGumbo } from '../../src/common/userId'
import { googlePlaces } from '../../src/server/location/googlePlaces'
import { devMediaRoutes } from '../../src/server/routes/devMedia'
import { healthRoutes } from '../../src/server/routes/health'
import { mediaRoutes } from '../../src/server/routes/media'
import { googlePlacesStub } from '../../src/test/googlePlacesStub'
import { groupFixture } from '../../src/test/groupFixtures'
import { insertFixtureUsers } from '../../src/test/insertFixtureUsers'
import { seedSettingsCleanup3 } from '../../src/test/settingsCleanup3Fixture'

/** Isolated real API/database/mail fixture, supplied explicitly per platform. */
async function main(): Promise<void> {
  const artifacts = process.env.TS_CREATION_ARTIFACTS
  const bind = process.env.TS_CREATION_NATIVE_HOST
  const host = process.env.TS_SETTINGS3_API_HOST
  const mediaSource = process.env.TS_SETTINGS3_NATIVE_MEDIA_ROOT
  let mediaRoot: string | undefined
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
    if (mediaRoot != null)
      try {
        await rm(mediaRoot, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
    if (errors.length !== 0)
      throw new AggregateError(errors, 'Native fixture cleanup failed')
  }
  try {
    if (mediaSource != null) {
      // Express deliberately refuses dotfiles; private artifact directories
      // may have a hidden ancestor. Serve an owned disposable media copy.
      mediaRoot = await mkdtemp(join(tmpdir(), 'settings-native-media-'))
      await cp(mediaSource, mediaRoot, { recursive: true })
    }
    let mountMedia: ((publicUrl: string) => void) | undefined
    const f = await groupFixture(
      undefined,
      bind,
      (app, { db, media }) => {
        let router: express.Router | undefined
        app.use((req, res, next) => {
          if (router == null) next()
          else router(req, res, next)
        })
        mountMedia = publicUrl => {
          if (mediaRoot == null) return
          router = express.Router()
          router.use(
            '/api/v1',
            mediaRoutes(db, { ...media, mediaRoot, publicUrl })
          )
          router.use(devMediaRoutes(mediaRoot, media.mediaSecret))
        }
      },
      googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl })
    )
    fixture = f
    await seedSettingsCleanup3(f)
    // Long enough to exercise sticky navigation on a tablet, not just a
    // short page whose section row never has an opportunity to move.
    for (let index = 0; index < 8; index++)
      await f.h.db
        .insertInto('games')
        .values({
          id: `gam_settings3_scroll_${index}`,
          home_team_id: f.teamA,
          away_team_id: f.teamB,
          season_id: f.seasonA,
          start_at: new Date(Date.UTC(2027, 3, 11 + index, 19)),
          end_at: new Date(Date.UTC(2027, 3, 11 + index, 21)),
          timezone: 'UTC',
          venue: 'Demo Field',
          status: 'scheduled'
        })
        .execute()
    await insertFixtureUsers(f.h.db, {
      id: userIdOfGumbo(109),
      legacyId: 'usr_settings3_native_no_email',
      display_name: 'Rickey Henderson',
      first_name: 'Rickey',
      last_name: 'Henderson',
      login_enabled: false,
      is_admin: false
    })
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_settings3_native_no_email',
        team_id: f.teamA,
        user_id: userIdOfGumbo(109),
        is_player: true
      })
      .execute()
    // Keep event attendance longer than a tablet viewport so two successive
    // scrolls can prove the section pills stay fixed while rows move.
    const attendanceNames = [
      'Jackie Robinson',
      'Willie Mays',
      'Hank Aaron',
      'Yogi Berra',
      'Ted Williams',
      'Stan Musial',
      'Roberto Clemente',
      'Nolan Ryan',
      'Cal Ripken',
      'Tony Gwynn',
      'Pedro Martinez',
      'Greg Maddux'
    ]
    for (const [index, name] of attendanceNames.entries()) {
      const id = 110 + index
      const [first, last] = name.split(' ')
      await insertFixtureUsers(f.h.db, {
        id,
        legacyId: `usr_settings3_attendance_${index}`,
        display_name: name,
        first_name: first,
        last_name: last,
        login_enabled: false,
        is_admin: false
      })
      await f.h.db
        .insertInto('memberships')
        .values({
          id: `mem_settings3_attendance_${index}`,
          team_id: f.teamA,
          user_id: userIdOfGumbo(id),
          is_player: true
        })
        .execute()
    }
    if (mediaRoot != null) {
      const media = JSON.parse(
        await readFile(join(mediaRoot, 'media-manifest.json'), 'utf8')
      ) as {
        videoId: string
        durationSec: number
        width: number
        height: number
      }
      if (media.videoId !== 'vid_settings3_native' || media.durationSec !== 90)
        throw new Error('Supply the prepared synthetic native HLS asset')
      await f.h.db
        .insertInto('videos')
        .values({
          id: media.videoId,
          game_id: 'gam_settings3_final',
          kind: 'program',
          title: 'Native fixture video',
          storage: 'local',
          status: 'ready',
          start_at: new Date('2027-04-10T19:00:00Z'),
          start_at_source: 'manual',
          duration_sec: media.durationSec,
          num_cameras: 1,
          width: media.width,
          height: media.height,
          codecs: 'h264'
        })
        .execute()
    }
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
          redirect: 'manual',
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) })
        })
          .then(async response => {
            res.status(response.status)
            for (const name of [
              'content-range',
              'accept-ranges',
              'cache-control',
              'etag'
            ]) {
              const value = response.headers.get(name)
              if (value != null) res.setHeader(name, value)
            }
            const location = response.headers.get('location')
            if (location != null)
              res.setHeader('location', String(reachable(location)))
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
    mountMedia?.(`http://${host}:${address.port}`)
    const controlApp = express()
    controlApp.use(express.json())
    controlApp.delete('/code', (req, res) => {
      if (typeof req.query.email !== 'string') {
        res.status(400).json({ error: 'Supply fixture email' })
        return
      }
      f.h.mail.delete(req.query.email)
      res.sendStatus(204)
    })
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
          .select(['id', 'name', 'kind', 'locality'])
          .orderBy('id')
          .execute(),
        f.h.db
          .selectFrom('system_settings')
          .selectAll()
          .orderBy('key')
          .execute()
      ])
        .then(
          ([seasons, parents, games, memberships, users, teams, settings]) => {
            res.json({
              seasons,
              parents,
              games,
              memberships,
              users,
              teams,
              settings
            })
          }
        )
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
          withoutEmailPlayer: 109,
          adminCandidate: 106,
          game: 'gam_settings3_scheduled',
          live: 'gam_settings3_live',
          final: 'gam_settings3_final',
          video: mediaRoot == null ? null : 'vid_settings3_native'
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
