import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { routePath } from '../app/navigation/routes'
import { userIdOfGumbo } from '../common/userId'
import { attachDictation, type Recogniser } from '../server/dictation/route'
import type { SttHandlers } from '../server/dictation/stt'
import { devMediaRoutes } from '../server/routes/devMedia'
import { mediaRoutes } from '../server/routes/media'
import { tessRoutes } from '../server/routes/tess'
import { umpireRoutes } from '../server/routes/umpires'
import { dictatingHealth } from './dictationFakes'
import {
  type FakeAnthropic,
  fakeAnthropic,
  type ScriptEntry,
  text,
  tool
} from './fakeAnthropic'
import { type GroupFixture, groupFixture } from './groupFixtures'
import { seedUmpireTypes } from './umpireTypes'

/**
 * Tess end to end: the group fixture's leagues, seasons and teams with a
 * season of games, a game with two camera angles, an umpire, the Tess routes
 * answering from a scripted model, and dictation that hears one sentence.
 *
 * Demo Hawks is two teams here: the account harness's own and the group
 * fixture's `f.teamA`, which user 101 administers. Everything below means
 * `f.teamA`, and the scripted answers name it by id.
 */
export interface TessFixtureOptions {
  /** The web build the harness serves, for a browser. */
  webRoot?: string
  /** Where the API listens; a phone needs the Mac's address. */
  bindHost?: string
  /**
   * The origin the app reaches the API at, for the media addresses and the
   * beacon the scripted HTML points at. The harness's own by default.
   */
  publicOrigin?: string
  /** False leaves Tess's settings out, and health says `tess: false`. */
  tess?: boolean
  /** False skips the two camera angles and their HLS. */
  videos?: boolean
}

export interface TessFixture {
  f: GroupFixture
  model: FakeAnthropic
  /** The origin the app is given, which the beacon address uses. */
  origin: () => string
  /** Hits on `/__tess/beacon`, which a remote load from rich HTML would make. */
  beaconHits: () => number
  /** Utterances the microphone started, and what each was heard as. */
  dictation: { begun: number; heard: string[] }
  /** The six final games, oldest first, then the May 3 game and an open one. */
  games: { finals: string[]; may3: string; scheduled: string }
  videos: { firstBase: string; homePlate: string }
  /** The app paths the scripted answers link to. */
  links: { teamSettings: string; firstBaseAngle: string }
  close: () => Promise<void>
}

/** What the microphone hears, whatever is said into it. */
export const HEARD = 'Where are my team settings?'

/** The six finals: Demo Hawks' runs, then Demo Eagles'. */
const FINALS: Array<[number, number]> = [
  [5, 3],
  [2, 6],
  [7, 4],
  [4, 4],
  [9, 1],
  [3, 5]
]

/** Saturdays from 6 March 2027, one a week. */
const saturday = (week: number): Date =>
  new Date(Date.UTC(2027, 2, 6 + 7 * week, 18))

function chartOf(origin: string): string {
  const width = 360
  const height = 160
  const bar = 40
  const scale = 12
  const bars = FINALS.map(([runs], index) => {
    const x = 20 + index * (bar + 16)
    const h = runs * scale
    return `<rect x="${x}" y="${height - 24 - h}" width="${bar}" height="${h}" fill="#2f6fde"/><text x="${x + bar / 2}" y="${height - 8}" font-size="12" text-anchor="middle">G${index + 1}</text><text x="${x + bar / 2}" y="${height - 28 - h}" font-size="12" text-anchor="middle">${runs}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>Demo Hawks runs per game</title>${bars}<image href="${origin}/__tess/beacon?from=svg" x="0" y="0" width="1" height="1"/></svg>\n<img src="${origin}/__tess/beacon?from=img" alt="" width="1" height="1">`
}

function standingsOf(origin: string): string {
  const won = FINALS.filter(([us, them]) => us > them).length
  const lost = FINALS.filter(([us, them]) => us < them).length
  const tied = FINALS.length - won - lost
  return `<table><tr><th>Team</th><th>W</th><th>L</th><th>T</th></tr><tr><td>Demo Hawks</td><td>${won}</td><td>${lost}</td><td>${tied}</td></tr><tr><td>Demo Eagles</td><td>${lost}</td><td>${won}</td><td>${tied}</td></tr><tr><td colspan="4"><img src="${origin}/__tess/beacon?from=table" alt="" width="1" height="1"></td></tr></table>`
}

/** The scripted model's answers, by what the person said. */
export function tessScript(fixture: {
  teamA: string
  seasonA: string
  may3: string
  scheduled: string
  links: TessFixture['links']
  origin: () => string
}): ScriptEntry[] {
  const { teamA, seasonA, may3, scheduled, links, origin } = fixture
  return [
    {
      match: /where are my team settings/i,
      rounds: [
        tool('api_get', { path: `/teams/${teamA}` }),
        text(
          `Your team's settings are here: [Home › Demo Hawks › Settings](${links.teamSettings} "path")`
        )
      ]
    },
    {
      match: /first-base angle/i,
      rounds: [
        tool('api_get', { path: `/games/${may3}` }),
        text(
          `Here is the May 3 game from first base: [First base, May 3](${links.firstBaseAngle})`
        )
      ]
    },
    {
      match: /chart our runs/i,
      rounds: [
        () => text(`Demo Hawks' runs per game:\n\n${chartOf(origin())}\n`)
      ]
    },
    {
      match: /standings as a table/i,
      rounds: [() => text(`The standings:\n\n${standingsOf(origin())}\n`)]
    },
    {
      match: /add a game against demo eagles/i,
      rounds: [
        tool(
          'confirmChange',
          {
            method: 'POST',
            path: `/teams/${teamA}/games`,
            body: {
              games: [
                {
                  startAt: '2027-05-15T10:00:00-07:00',
                  opponent: { name: 'Demo Eagles' },
                  side: 'home',
                  seasonId: seasonA,
                  venue: 'Demo Field'
                }
              ]
            },
            summary:
              'Add a home game against Demo Eagles on Saturday 15 May at 10:00'
          },
          'I can add that game for you.'
        ),
        text('Hold Confirm on the card to add the game.')
      ]
    },
    {
      match: /^The user confirmed the change/,
      rounds: [
        text(
          'Done: the game against Demo Eagles on Saturday 15 May at 10:00 is on the schedule.'
        )
      ]
    },
    {
      match: /record a strike/i,
      rounds: [
        tool('confirmChange', {
          method: 'POST',
          path: `/games/${may3}/events`,
          body: { type: 'pitch', call: 'S' },
          summary: 'Record a strike for the batter'
        }),
        text(
          'I cannot record plays. Live scoring happens on the scoring screen.'
        )
      ]
    },
    {
      match: /score the next game/i,
      rounds: [
        text(
          `Here is the scoring screen: [Score Demo Hawks vs Demo Eagles](/games/${scheduled}/score)`
        )
      ]
    },
    {
      match: /poem/i,
      rounds: [
        text(
          'I can only help with finding information or taking actions in TeamStation.'
        )
      ]
    },
    {
      match: /stats|attached|here are/i,
      rounds: [
        text('Thanks. I have your CSV and your picture, and I will use both.')
      ]
    }
  ]
}

/** A recogniser that hears `HEARD` in any utterance with audio in it. */
function fakeRecogniser(
  handlers: SttHandlers,
  dictation: TessFixture['dictation']
): Recogniser {
  let bytes = 0
  return {
    retarget: () => undefined,
    begin: () => {
      bytes = 0
      dictation.begun++
    },
    write: pcm => {
      bytes += pcm.length
    },
    end: () => {
      const heard = bytes > 0 ? HEARD : ''
      dictation.heard.push(heard)
      setTimeout(() => {
        handlers.onFinal(heard)
      }, 50)
    },
    close: () => undefined
  }
}

/** Two angles' HLS, from one generated clip, in a disposable media root. */
async function makeMedia(mediaRoot: string, ids: string[]): Promise<void> {
  const first = join(mediaRoot, 'work/videos', ids[0])
  await mkdir(first, { recursive: true })
  execFileSync(process.env.TS_FFMPEG ?? 'ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=24',
    '-t',
    '90',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '48',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    join(first, 'master.m3u8')
  ])
  for (const id of ids.slice(1))
    await cp(first, join(mediaRoot, 'work/videos', id), { recursive: true })
}

export async function tessFixture(
  options: TessFixtureOptions = {}
): Promise<TessFixture> {
  const withTess = options.tess !== false
  const withVideos = options.videos !== false
  const model = await fakeAnthropic()
  // No dot directory on the way, which `sendFile` would refuse.
  const mediaRoot = await mkdtemp(join(tmpdir(), 'tess-media-'))
  const videos = { firstBase: 'vid_tess_first', homePlate: 'vid_tess_home' }
  let origin = ''
  let beacon = 0
  const publicOrigin = (): string => options.publicOrigin ?? origin
  const dictation: TessFixture['dictation'] = { begun: 0, heard: [] }
  let f: GroupFixture | undefined
  let detach: (() => void) | undefined
  try {
    if (withVideos)
      await makeMedia(mediaRoot, [videos.firstBase, videos.homePlate])
    f = await groupFixture(
      options.webRoot,
      options.bindHost,
      (app, { db, media }) => {
        // Before the harness's own health stub, so this one answers.
        app.get('/api/v1/health', (_req, res, next) => {
          dictatingHealth()
            .then(health => res.json({ ...health, tess: withTess }))
            .catch(next)
        })
        app.use(
          '/api/v1',
          mediaRoutes(db, {
            ...media,
            mediaRoot,
            publicUrl: options.publicOrigin ?? ''
          })
        )
        app.use(devMediaRoutes(mediaRoot, media.mediaSecret))
        app.use('/api/v1', umpireRoutes(db, media))
        app.use(
          '/api/v1',
          tessRoutes(db, {
            settings: withTess
              ? {
                  apiKey: 'test-key-placeholder',
                  baseUrl: model.baseUrl,
                  model: 'claude-sonnet-5-5'
                }
              : null,
            origin: () => origin
          })
        )
        app.get('/__tess/beacon', (_req, res) => {
          beacon++
          res
            .type('image/gif')
            .send(
              Buffer.from(
                'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
                'base64'
              )
            )
        })
        app.get('/__tess/beacon-count', (_req, res) => {
          res.json({ count: beacon })
        })
        app.get('/__tess/requests', (_req, res) => {
          res.json(model.calls)
        })
      }
    )
    origin = f.h.origin
    const { db } = f.h
    // User 101 umpires in Demo Hawks' league, so the header has its button.
    await seedUmpireTypes(db, f.leagueA)
    await db
      .updateTable('leagues')
      .set({ umpire_management: true, umpire_credits: true })
      .where('id', '=', f.leagueA)
      .execute()
    await db
      .insertInto('league_members')
      .values({
        id: 'lmb_tess_umpire',
        league_id: f.leagueA,
        user_id: userIdOfGumbo(101),
        role: 'member'
      })
      .execute()
    await db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueA,
        user_id: userIdOfGumbo(101),
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    const season = f.seasonA
    await db
      .insertInto('season_teams')
      .values(
        [f.teamA, f.teamB].map(team => ({
          season_id: season,
          team_id: team,
          active: true
        }))
      )
      .onConflict(oc => oc.doNothing())
      .execute()
    const finals = FINALS.map((_, index) => `gam_tess_final_${index + 1}`)
    for (const [index, [ours, theirs]] of FINALS.entries()) {
      const home = index % 2 === 0
      await db
        .insertInto('games')
        .values({
          id: finals[index],
          home_team_id: home ? f.teamA : f.teamB,
          away_team_id: home ? f.teamB : f.teamA,
          season_id: f.seasonA,
          start_at: saturday(index),
          end_at: new Date(saturday(index).getTime() + 2 * 3600_000),
          timezone: 'UTC',
          venue: 'Demo Field',
          status: 'final',
          home_score: home ? ours : theirs,
          away_score: home ? theirs : ours
        })
        .execute()
    }
    const may3 = 'gam_tess_may3'
    await db
      .insertInto('games')
      .values({
        id: may3,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date('2027-05-03T18:00:00Z'),
        end_at: new Date('2027-05-03T20:00:00Z'),
        timezone: 'UTC',
        venue: 'Demo Field',
        status: 'final',
        home_score: 6,
        away_score: 2
      })
      .execute()
    const scheduled = 'gam_tess_scheduled'
    await db
      .insertInto('games')
      .values({
        id: scheduled,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date('2027-05-22T18:00:00Z'),
        end_at: new Date('2027-05-22T20:00:00Z'),
        timezone: 'UTC',
        venue: 'Demo Field',
        status: 'scheduled'
      })
      .execute()
    if (withVideos)
      for (const [id, camera] of [
        [videos.firstBase, 'First base'],
        [videos.homePlate, 'Home plate']
      ] as const)
        await db
          .insertInto('videos')
          .values({
            id,
            game_id: may3,
            kind: 'program',
            title: `Demo game — ${camera}`,
            storage: 'local',
            status: 'ready',
            start_at: new Date('2027-05-03T18:00:00Z'),
            start_at_source: 'manual',
            duration_sec: 90,
            num_cameras: 1,
            width: 640,
            height: 360,
            codecs: 'h264'
          })
          .execute()
    detach = attachDictation(f.h.server, {
      db,
      config: {
        apiKey: 'test-key-placeholder',
        baseUrl: 'http://model.example.test/v1',
        anthropic: {
          apiKey: 'test-key-placeholder',
          baseUrl: 'http://model.example.test/v1'
        },
        sttUrl: 'wss://stt.example.test',
        sttModel: 'stt-fake',
        model: 'claude-haiku-5-5'
      },
      openRecogniser: handlers => fakeRecogniser(handlers, dictation)
    }).close
    const links = {
      teamSettings: routePath({
        name: 'groupSettings',
        kind: 'team',
        id: f.teamA
      }),
      firstBaseAngle: routePath({
        name: 'game',
        gameId: may3,
        tab: 'watch',
        videoId: videos.firstBase,
        angles: [videos.firstBase]
      })
    }
    model.setScript(
      tessScript({
        teamA: f.teamA,
        seasonA: f.seasonA,
        may3,
        scheduled,
        links,
        origin: publicOrigin
      })
    )
    const fixture = f
    return {
      f: fixture,
      model,
      origin: publicOrigin,
      beaconHits: () => beacon,
      dictation,
      games: { finals, may3, scheduled },
      videos,
      links,
      close: async () => {
        detach?.()
        await fixture.h.close()
        await model.close()
        await rm(mediaRoot, { recursive: true, force: true })
      }
    }
  } catch (error) {
    detach?.()
    await f?.h.close().catch(() => undefined)
    await model.close().catch(() => undefined)
    await rm(mediaRoot, { recursive: true, force: true })
    throw error
  }
}
