import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Router } from 'express'
import { makeId } from '../../src/common/ids'
import { userIdOfGumbo } from '../../src/common/userId'
import type { MediaContext } from '../../src/server/media/mediaContext'
import { verifyMediaPath } from '../../src/server/media/mediaTokens'
import { eventListRoutes } from '../../src/server/routes/eventList'
import { followRoutes } from '../../src/server/routes/follows'
import { mediaRoutes } from '../../src/server/routes/media'
import { userRoutes } from '../../src/server/routes/users'
import {
  accountHarness,
  type AccountHarness
} from '../../src/test/accountHarness'

/** Synthetic identities and media only; a real database and authorization routes. */
export async function tvFixture(): Promise<AccountHarness> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tv-fixture-'))
  const mediaRouter = Router()
  let media!: MediaContext
  const h = await accountHarness(
    undefined,
    (app, fixture) => {
      media = fixture.media
      media.mediaRoot = directory
      app.get('/api/v1/videos/:videoId/stills/:filename', (_req, res) => {
        res.sendFile(path.resolve('src/test/fixtures/still.jpg'))
      })
      app.get('/media/{*path}', (req, res) => {
        const checked = verifyMediaPath(media.mediaSecret, req.path)
        if (!checked.ok) {
          res.status(403).end()
          return
        }
        res.sendFile(
          path.join(directory, checked.media.dir, checked.media.rest)
        )
      })
      app.use('/api/v1', mediaRouter)
    },
    '127.0.0.1',
    (app, { db, media }) => {
      app.use('/api/v1', eventListRoutes(db, media))
      app.use('/api/v1', userRoutes(db, media.space))
      app.use('/api/v1', followRoutes(db, media))
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
    for (let i = 0; i < 29; i++) {
      const gameId = `gam_tv_${i}`
      const start = new Date(Date.UTC(2026, i < 15 ? 9 : 8, 30 - (i % 15), 18))
      const teamId = i === 28 ? 'tem_secret' : teams[i % 3]
      await h.db
        .insertInto('games')
        .values({
          id: gameId,
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
        // Browsing does not need media bytes. Playback journeys provide the local clock clip.
        const source = process.env.TV_PROBE_FILE
        if (source !== undefined)
          await symlink(
            path.resolve(source),
            path.join(videoDirectory, 'video.mp4')
          )
        await writeFile(
          path.join(videoDirectory, 'master.m3u8'),
          '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:60\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:60,\nvideo.mp4\n#EXT-X-ENDLIST\n'
        )
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
            gameId: gameId,
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
  return h
}
