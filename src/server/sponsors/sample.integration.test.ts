import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import {
  DEFAULT_SPONSOR_SAMPLE_KEY,
  defaultSponsorSettings
} from '../../common/nodeSettings'
import type { SampleVideo } from '../../common/sponsors/types'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import type { VideosTable } from '../db/database'
import { mediaBase } from '../media/spacesHls'
import { mediaRoutes } from '../routes/media'
import { sponsorRoutes } from '../routes/sponsors'
import { sampleWindow } from './sample'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2027-04-10T18:00:00.000Z')

/** U6: the video a league's sponsor previews play. */
describe('U6 the sponsor sample video', function () {
  this.timeout(120000)
  let f: GroupFixture
  const mediaRoot = mkdtempSync(join(tmpdir(), 'sponsor-sample-media-'))
  const ids: Record<string, string> = {}

  /** A league straight in `leagues`, which 101 administers, and a team in it. */
  const league = async (key: string): Promise<string> => {
    const id = `lea_sample_${key}`
    await f.h.db.insertInto('leagues').values({ id, name: key }).execute()
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: `rol_sample_${key}`,
        user_id: userIdOfGumbo(101),
        scope_type: 'league',
        scope_id: id,
        role: 'admin',
        granted_by: null
      })
      .execute()
    await f.h.db
      .insertInto('teams')
      .values({
        id: `tem_sample_${key}`,
        name: `${key} Team`,
        league_id: id,
        kind: 'full',
        created_from: 'manual'
      })
      .execute()
    return id
  }

  const game = async (
    home: string,
    away: string,
    seasonId: string | null
  ): Promise<string> => {
    const id = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        season_id: seasonId,
        start_at: new Date(NOW - 7 * DAY)
      })
      .execute()
    return id
  }

  const video = async (
    gameId: string,
    title: string,
    values: Partial<{
      storage: VideosTable['storage']
      kind: VideosTable['kind']
      status: 'live' | 'ready' | 'unavailable'
      durationSec: number | null
      startAt: Date | null
      hidden: boolean
      files: boolean
    }> = {}
  ): Promise<string> => {
    const id = makeId('video')
    const storage = values.storage ?? 'spaces'
    await f.h.db
      .insertInto('videos')
      .values({
        id,
        game_id: gameId,
        kind: values.kind ?? 'program',
        title,
        storage,
        status: values.status ?? 'ready',
        start_at:
          values.startAt === undefined ? new Date(NOW - DAY) : values.startAt,
        duration_sec:
          values.durationSec === undefined ? 2400 : values.durationSec,
        hidden: values.hidden ?? false,
        space_secret:
          storage === 'spaces' ? randomBytes(16).toString('hex') : null,
        created_at: new Date(NOW - 30 * DAY),
        updated_at: new Date(NOW - 30 * DAY)
      })
      .execute()
    if (storage === 'local' && values.files !== false) {
      const dir = join(mediaRoot, 'work/videos', id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U\n')
    }
    return id
  }

  before(async function () {
    f = await groupFixture(undefined, undefined, (app, { db, media }) => {
      const here = { ...media, mediaRoot }
      app.use('/api/v1', mediaRoutes(db, here))
      app.use(
        '/api/v1',
        sponsorRoutes(db, here, {
          uploadsDir: mediaRoot,
          clock: () => new Date(NOW)
        })
      )
    })
    // League A: in its season, a "Home Plate" recording and a newer "First
    // Base", a newer hidden "Home" and a newer stub with no length.
    const seasonGame = await game(f.teamA, f.standaloneTeam, f.seasonA)
    ids.homePlate = await video(seasonGame, 'Home Plate', {
      kind: 'live',
      startAt: new Date(NOW - 2 * DAY)
    })
    ids.firstBase = await video(seasonGame, 'First Base', {
      startAt: new Date(NOW - DAY)
    })
    await video(seasonGame, 'Home', {
      hidden: true,
      startAt: new Date(NOW - 1000)
    })
    await video(seasonGame, 'Home stub', {
      status: 'unavailable',
      durationSec: null,
      startAt: new Date(NOW - 1000)
    })
    // League B: no home title, an older "First Base" and a newer 20-minute
    // "Outfield".
    const leagueBGame = await game(f.teamB, f.standaloneTeam, f.seasonB)
    await video(leagueBGame, 'First Base', { startAt: new Date(NOW - 3 * DAY) })
    ids.outfield = await video(leagueBGame, 'Outfield', {
      durationSec: 1200,
      startAt: new Date(NOW - 2 * DAY)
    })
    // League C: a game in no season, of one of its teams, with the newest
    // "Home Plate" anywhere, ready on this server's disk.
    ids.leagueC = await league('C')
    const teamGame = await game(f.standaloneTeam, 'tem_sample_C', null)
    ids.localHome = await video(teamGame, 'home plate (left)', {
      storage: 'local',
      durationSec: 1200,
      startAt: null
    })
    // League D: its only recording's files are gone.
    ids.leagueD = await league('D')
    const goneGame = await game('tem_sample_D', f.standaloneTeam, null)
    ids.gone = await video(goneGame, 'Home Plate', {
      storage: 'local',
      files: false
    })
    // League E: no footage at all.
    ids.leagueE = await league('E')
  })

  after(async function () {
    await f?.h.close()
    rmSync(mediaRoot, { recursive: true, force: true })
  })

  const sample = async (leagueId: string): Promise<SampleVideo> => {
    const response = await f.h.request(
      'GET',
      `/leagues/${leagueId}/sponsors/sample`,
      undefined,
      leagueId === f.leagueB ? 102 : 101
    )
    expect(response.status, await response.clone().text()).equals(200)
    return (await response.json()) as SampleVideo
  }

  /** What `GET /videos/:videoId/playback` answers, signed at `NOW`. */
  const playbackUrl = async (videoId: string): Promise<string | null> => {
    const realNow = Date.now
    Date.now = () => NOW
    try {
      const response = await f.h.request('GET', `/videos/${videoId}/playback`)
      expect(response.status).equals(200)
      return ((await response.json()) as { url: string | null }).url
    } finally {
      Date.now = realNow
    }
  }

  const overlay = {
    logo: defaultSponsorSettings.logo,
    reel: defaultSponsorSettings.reel
  }

  it('plays the newest "Home Plate" recording over a newer "First Base", a hidden one and a stub', async function () {
    const answer = await sample(f.leagueA)
    expect(answer).to.include({ kind: 'recording', videoId: ids.homePlate })
    expect(answer.window).deep.equals([1800, 1920])
    expect(answer.overlay).deep.equals(overlay)
  })

  it('plays the newest of any title without a home title, the first two minutes of a short one', async function () {
    const answer = await sample(f.leagueB)
    expect(answer).to.include({ kind: 'recording', videoId: ids.outfield })
    expect(answer.window).deep.equals([0, 120])
  })

  it('never plays another league’s recording', async function () {
    for (const [leagueId, own] of [
      [f.leagueA, ids.homePlate],
      [f.leagueB, ids.outfield],
      [ids.leagueC, ids.localHome]
    ]) {
      const answer = await sample(leagueId)
      expect(answer.kind, leagueId).equals('recording')
      expect((answer as { videoId: string }).videoId, leagueId).equals(own)
    }
  })

  it('answers the URL playback answers, for a live video in the Space and a ready local one', async function () {
    const spaces = await sample(f.leagueA)
    expect(spaces.url).equals(await playbackUrl(ids.homePlate))
    expect(spaces.url).matches(
      new RegExp(`/api/v1/videos/${ids.homePlate}/hls/master\\.m3u8\\?t=`)
    )
    const local = await sample(ids.leagueC)
    expect(local.url).equals(await playbackUrl(ids.localHome))
    expect(local.url).matches(/\/media\/\d+\/[^/]+\/work\/videos\//)
  })

  it('plays the node sample at the default key with no footage, or when the files are gone', async function () {
    const node = {
      kind: 'node',
      url: `${mediaBase(f.h.space)}/${DEFAULT_SPONSOR_SAMPLE_KEY}`,
      window: [0, 120],
      overlay
    }
    expect(await sample(ids.leagueE)).deep.equals(node)
    expect(await sample(ids.leagueD)).deep.equals(node)
  })

  it('takes 30:00–32:00 of a recording at least 32 minutes long, else its first two minutes', function () {
    expect(sampleWindow(2400)).deep.equals([1800, 1920])
    expect(sampleWindow(1920)).deep.equals([1800, 1920])
    expect(sampleWindow(1919)).deep.equals([0, 120])
    expect(sampleWindow(1200)).deep.equals([0, 120])
    expect(sampleWindow(45)).deep.equals([0, 45])
  })
})
