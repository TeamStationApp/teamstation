import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Router } from 'express'

import { asLineScoreTimeline } from '../../src/common/api'
import { asPostEventsBody } from '../../src/common/gumboPlay'
import { makeId } from '../../src/common/ids'
import { ScoringSession } from '../../src/common/scoring/session'
import { userIdOfGumbo } from '../../src/common/userId'
import { postGamePlays } from '../../src/server/events/postPlays'
import type { MediaContext } from '../../src/server/media/mediaContext'
import { verifyMediaPath } from '../../src/server/media/mediaTokens'
import { eventListRoutes } from '../../src/server/routes/eventList'
import { eventRoutes } from '../../src/server/routes/events'
import { followRoutes } from '../../src/server/routes/follows'
import { mediaRoutes } from '../../src/server/routes/media'
import { nodeAdministrationRoutes } from '../../src/server/routes/nodeAdministration'
import { scoreboardRoutes } from '../../src/server/routes/scoreboard'
import { userRoutes } from '../../src/server/routes/users'
import type { ScoreboardStore } from '../../src/server/scoreboard/scoreboardStore'
import {
  type AccountHarness,
  accountHarness
} from '../../src/test/accountHarness'
import { insertFixtureUsers } from '../../src/test/insertFixtureUsers'
import {
  AWAY_PLAYERS,
  HOME_PLAYERS,
  MemoryStore,
  replayActions,
  replaySetup
} from '../../src/test/replayGameFixture'

/** Synthetic identities and media only; a real database and authorization routes. */
export async function tvFixture(
  options: {
    scored?: boolean
    webRoot?: string
    wideStats?: boolean
    statsInnings?: number
  } = {}
): Promise<
  AccountHarness & {
    tvMedia: { fail: boolean; live: boolean; searchFail: boolean }
  }
> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tv-fixture-'))
  const hls = path.join(directory, 'clock')
  const source = process.env.TV_PROBE_FILE
  if (source !== undefined) {
    await mkdir(hls)
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path.resolve(source),
      '-c',
      'copy',
      '-hls_time',
      '4',
      '-hls_segment_type',
      'fmp4',
      '-hls_playlist_type',
      'vod',
      path.join(hls, 'master.m3u8')
    ])
  }
  const tvMedia = { fail: false, live: false, searchFail: false }
  const mediaRouter = Router()
  let media!: MediaContext
  const h = await accountHarness(
    options.webRoot,
    (app, fixture) => {
      app.use(['/api/v1/teams', '/api/v1/users'], (req, res, next) => {
        if (tvMedia.searchFail && req.query.q !== undefined) {
          res.status(503).json({ error: 'Synthetic search outage' })
          return
        }
        next()
      })
      if (options.wideStats === true)
        app.use('/api/v1/games/gam_tv_0/line-score', (_req, res, next) => {
          const send = res.json.bind(res)
          res.json = body => {
            const timeline = asLineScoreTimeline(body)
            return send({
              ...timeline,
              teams: {
                away: 'Demo Mountain Valley Visitors',
                home: 'Demo Coastal Valley Hawks'
              },
              steps: timeline.steps.map(step => ({
                ...step,
                line: {
                  away: {
                    ...step.line.away,
                    innings: Array.from(
                      { length: options.statsInnings ?? 25 },
                      (_, i) => (i === 24 ? 7 : 0)
                    )
                  },
                  home: {
                    ...step.line.home,
                    innings: Array.from(
                      { length: options.statsInnings ?? 25 },
                      (_, i) => (i === 24 ? 8 : 0)
                    )
                  }
                }
              }))
            })
          }
          next()
        })
      media = fixture.media
      media.mediaRoot = directory
      app.get('/api/v1/videos/:videoId/stills/:filename', (_req, res) => {
        res.sendFile(path.resolve('src/test/fixtures/still.jpg'))
      })
      app.get('/media/{*path}', async (req, res) => {
        if (tvMedia.fail) {
          res.status(503).end()
          return
        }
        const checked = verifyMediaPath(media.mediaSecret, req.path)
        if (!checked.ok) {
          res.status(403).end()
          return
        }
        const file = path.join(directory, checked.media.dir, checked.media.rest)
        if (tvMedia.live && file.endsWith('.m3u8')) {
          const manifest = await readFile(file, 'utf8')
          res
            .type('application/vnd.apple.mpegurl')
            .send(
              manifest
                .replace(/#EXT-X-ENDLIST\s*/g, '')
                .replace(/#EXT-X-PLAYLIST-TYPE:VOD\s*/g, '')
            )
          return
        }
        res.sendFile(file)
      })
      app.use('/api/v1', mediaRouter)
    },
    '127.0.0.1',
    (app, { db, media }) => {
      app.use('/api/v1', nodeAdministrationRoutes(db, media.space))
      app.use('/api/v1', eventListRoutes(db, media))
      app.use('/api/v1', userRoutes(db, media.space))
      app.use('/api/v1', followRoutes(db, media))
      app.use('/api/v1', eventRoutes(db))
      const noStore = new Proxy(
        {},
        {
          get: () => {
            throw new Error(
              'Only historical scoreboard endpoints are available'
            )
          }
        }
      ) as ScoreboardStore
      app.use('/api/v1', scoreboardRoutes(db, noStore))
    }
  )
  media.publicUrl = h.origin
  mediaRouter.use(mediaRoutes(h.db, media))
  try {
    const teams = ['tem_account', 'tem_comets', 'tem_falcons']
    await h.db
      .insertInto('teams')
      .values([
        { id: 'tem_comets', name: 'Demo Comets' },
        { id: 'tem_falcons', name: 'Demo Falcons' },
        { id: 'tem_opponent', name: 'Demo Visitors' },
        { id: 'tem_secret', name: 'Private Team' }
      ])
      .execute()
    for (const teamId of teams) {
      if (teamId !== 'tem_account')
        await h.db
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            team_id: teamId,
            user_id: userIdOfGumbo(101),
            role: 'member'
          })
          .execute()
      await h.db
        .insertInto('team_follows')
        .values({ user_id: userIdOfGumbo(101), team_id: teamId })
        .execute()
    }
    await h.db
      .insertInto('leagues')
      .values({ id: 'lea_tv', name: 'Demo League' })
      .execute()
    await h.db
      .insertInto('seasons')
      .values({
        id: 'sea_tv',
        name: 'Autumn',
        year: 2026,
        starts_on: '2026-09-01',
        ends_on: '2026-11-01',
        league_id: 'lea_tv'
      })
      .execute()
    for (let i = 0; i < 29; i++) {
      const gameId = `gam_tv_${i}`
      const start = new Date(Date.UTC(2026, i < 15 ? 9 : 8, 30 - (i % 15), 18))
      const teamId = i === 28 ? 'tem_secret' : teams[i % 3]
      await h.db
        .insertInto('games')
        .values({
          id: gameId,
          season_id: 'sea_tv',
          home_team_id: teamId,
          away_team_id: 'tem_opponent',
          start_at: start,
          venue: 'Demo Field',
          timezone: 'UTC',
          status: 'final'
        })
        .execute()
      await h.db
        .insertInto('game_player_stats')
        .values({
          id: `stat_tv_${i}`,
          game_id: gameId,
          gumbo_id: i % 2 === 0 ? 101 : 102,
          team_id: teamId,
          pa: 1
        })
        .execute()
      for (let angle = 0; angle < (i === 0 ? 4 : 1); angle++) {
        const id = `vid_tv_${i}_${angle}`
        const videoDirectory = path.join(directory, 'work/videos', id)
        await mkdir(videoDirectory, { recursive: true })
        if (source !== undefined) {
          for (const file of await readdir(hls))
            await symlink(path.join(hls, file), path.join(videoDirectory, file))
        } else {
          await writeFile(
            path.join(videoDirectory, 'master.m3u8'),
            '#EXTM3U\n#EXT-X-ENDLIST\n'
          )
        }
        await h.db
          .insertInto('videos')
          .values({
            id,
            game_id: gameId,
            title: ['Home plate', 'First base', 'Third base', 'Center field'][
              angle
            ],
            kind: 'program',
            storage: 'local',
            status: 'ready',
            start_at: start,
            duration_sec: 60,
            created_at: new Date(Date.UTC(2026, 9, 30 - (i % 28), 20))
          })
          .execute()
      }
      for (let n = 0; n < 4; n++)
        await h.db
          .insertInto('events')
          .values({
            id: `evt_tv_${i}_${n}`,
            gameId,
            battingTeamId: teamId,
            startTime: new Date(start.getTime() + (n * 10 + 5) * 1000),
            endTime: new Date(start.getTime() + (n * 10 + 8) * 1000),
            gumbo: {
              about: {
                atBatIndex: n,
                inning: 1,
                halfInning: 'bottom',
                isScoringPlay: n === 0
              },
              result: {
                eventType: n === 0 ? 'home_run' : 'single',
                awayScore: 0,
                homeScore: n + 1
              },
              credits: [
                {
                  eventType: n === 0 ? 'home_run' : 'single',
                  head: n === 0 ? 'Home run' : 'Single',
                  creditUserId: i % 2 === 0 ? 101 : 102,
                  teamId,
                  credit: { role: 'batter' },
                  assists: []
                }
              ]
            }
          })
          .execute()
    }
    if (options.scored === true) {
      await insertFixtureUsers(
        h.db,
        [...AWAY_PLAYERS, ...HOME_PLAYERS].map(player => ({
          id: player.gumboId,
          display_name: `${player.first} ${player.last}`,
          first_name: player.first,
          last_name: player.last,
          login_enabled: false
        }))
      )
      await h.db.deleteFrom('events').where('gameId', '=', 'gam_tv_0').execute()
      await h.db
        .updateTable('games')
        .set({ status: 'inProgress' })
        .where('id', '=', 'gam_tv_0')
        .execute()
      const store = new MemoryStore()
      const setup = replaySetup()
      for (const player of Object.values(setup.players))
        player.teamId =
          player.teamId === 'tem_replayHawks' ? 'tem_opponent' : 'tem_account'
      let time = Date.UTC(2026, 9, 30, 18)
      const session = await ScoringSession.open(
        store,
        'gam_tv_0',
        {
          gamePk: 'gam_tv_0',
          teams: {
            home: { id: 'tem_account', name: 'Demo Hawks' },
            away: { id: 'tem_opponent', name: 'Demo Visitors' }
          },
          setup
        },
        {
          now: () => new Date((time += 200)),
          setTimer: () => null,
          clearTimer: () => undefined
        }
      )
      for (const action of replayActions(setup)) {
        const applied = session.apply(action)
        if (applied.problems.length > 0)
          throw new Error(applied.problems[0].message)
      }
      await session.flush()
      const stored = store.storedForms()
      await postGamePlays(
        h.db,
        'gam_tv_0',
        asPostEventsBody({
          plays: stored.plays,
          currentPlay: stored.currentPlay,
          mode: 'live',
          source: { system: 'teamstation' }
        })
      )
    }
  } catch (error) {
    await h.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  const close = h.close
  h.close = async () => {
    try {
      await close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  return Object.assign(h, { tvMedia })
}
