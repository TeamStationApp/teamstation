import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { routePath } from '../app/navigation/routes'
import { userIdOfGumbo } from '../common/userId'
import { attachDictation, type Recogniser } from '../server/dictation/route'
import { dictationScopes } from '../server/dictation/scopes'
import type { SttHandlers } from '../server/dictation/stt'
import { startServerLogging } from '../server/observability/logging'
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
  thought,
  tool,
  tools
} from './fakeAnthropic'
import { type GroupFixture, groupFixture } from './groupFixtures'
import { insertFixtureUsers } from './insertFixtureUsers'
import { seedUmpireTypes } from './umpireTypes'

/**
 * Tess end to end: the group fixture's leagues, seasons and teams with a
 * season of games, a game with two camera angles, an umpire, the Tess routes
 * answering from a scripted model, and dictation that hears one sentence.
 *
 * Demo Hawks is two teams here: the account harness's own and the group
 * fixture's `f.teamA`, which user 101 administers. Everything below means
 * `f.teamA`, and the scripted answers name it by id.
 *
 * Two players for the links Tess makes of names: Tony Gwynn plays for
 * `f.teamA`, and Ozzie Smith for Demo Visitors (`f.standaloneTeam`), whose
 * profile user 101 may not see.
 *
 * The model streams its turns a piece at a time, and Tess's own reads of a
 * team take a moment (`slowReads`), so a browser or a phone sees her
 * thinking, her steps and her text arrive.
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
  /** How often a streamed turn keeps its connection open; the route's own by default. */
  keepAliveMs?: number
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
  /** The players' user ids: one user 101 may see, and one they may not. */
  players: { visible: string; hidden: string }
  /** Every `tess_request` the server logged, as the log would send it. */
  tessRequests: () => Array<{ L: string; P: Record<string, unknown> }>
  close: () => Promise<void>
}

/** How long Tess's own reads under `/teams` take here. */
export const READ_DELAY_MS = 700

/**
 * Where Tess's tools reach the API: a proxy in front of `origin` that holds
 * each read under `/api/v1/teams` for `READ_DELAY_MS` first.
 */
async function slowReads(
  origin: () => string
): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => {
    const forward = (): void => {
      const upstream = request(
        `${origin()}${req.url ?? '/'}`,
        { method: req.method, headers: req.headers },
        answer => {
          res.writeHead(answer.statusCode ?? 502, answer.headers)
          answer.pipe(res)
        }
      )
      upstream.on('error', () => {
        res.destroy()
      })
      req.pipe(upstream)
    }
    if ((req.url ?? '').startsWith('/api/v1/teams'))
      setTimeout(forward, READ_DELAY_MS)
    else forward()
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, server }
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

/**
 * The change proposing a home game of `teamA`'s against Demo Eagles at 10:00
 * on a Saturday of 2027, with its details in plain words, as Tess gives them.
 */
function gameAgainstEagles(
  teamA: string,
  seasonA: string,
  day: number,
  month: 'May' | 'June'
): Record<string, unknown> {
  const date = `2027-${month === 'May' ? '05' : '06'}-${String(day).padStart(2, '0')}`
  return {
    method: 'POST',
    path: `/teams/${teamA}/games`,
    body: {
      games: [
        {
          startAt: `${date}T10:00:00-07:00`,
          opponent: { name: 'Demo Eagles' },
          side: 'home',
          seasonId: seasonA,
          venue: 'Demo Field'
        }
      ]
    },
    summary: `Add a home game against Demo Eagles on Saturday ${day} ${month} at 10:00`,
    details: {
      Opponent: 'Demo Eagles',
      Date: `Sat ${month.slice(0, 3)} ${day}`,
      Time: '10:00 AM',
      Field: 'Demo Field'
    }
  }
}

/** A newsletter in pieces of three words, about 170 of them. */
const NEWSLETTER = Array.from(
  { length: 50 },
  (_, week) =>
    `Week ${week + 1}: the team practised hard and played well together.`
).join(' ')

/** The scripted model's answers, by what the person said. */
export function tessScript(fixture: {
  teamA: string
  seasonA: string
  may3: string
  scheduled: string
  links: TessFixture['links']
  players: TessFixture['players']
  origin: () => string
}): ScriptEntry[] {
  const { teamA, seasonA, may3, scheduled, links, players, origin } = fixture
  return [
    {
      // Two reads, each after a thought, then the answer: streamed, so the
      // app shows her thinking, both steps and her text as they come.
      match: /last two games/i,
      rounds: [
        thought(
          'They want their last two games. First I will read Demo Hawks to be sure which team this is.',
          tool(
            'api_get',
            { path: `/teams/${teamA}` },
            'Let me look at your team.'
          )
        ),
        thought(
          'Demo Hawks is their team. Next I will read its games, newest first, to find the two latest finals.',
          tool('api_get', { path: `/teams/${teamA}/games` }, 'Now its games.')
        ),
        thought(
          'The two latest finals are a 3 to 5 loss and a 9 to 1 win, both against Demo Eagles. I will give the scores, newest first.',
          text(
            'Your last two games, both against Demo Eagles: Demo Hawks lost the latest 3 to 5, and won the one before it 9 to 1.'
          )
        )
      ]
    },
    {
      // The roster names him; the answer leaves his name unlinked.
      match: /who plays shortstop/i,
      rounds: [
        tool('api_get', { path: `/teams/${teamA}/roster` }),
        text('Tony G plays shortstop for Demo Hawks.')
      ]
    },
    {
      match: /ozzie/i,
      rounds: [
        text(
          `Here is [Ozzie S](/players/${players.hidden}), who plays for Demo Visitors.`
        )
      ]
    },
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
          gameAgainstEagles(teamA, seasonA, 15, 'May'),
          'I can add that game for you.'
        ),
        text('Hold Confirm under the table to add the game.')
      ]
    },
    {
      // Three changes in one round, each game its own, with the same labels:
      // one table of three rows.
      match: /schedule three games against demo eagles/i,
      rounds: [
        tools(
          [
            {
              name: 'confirmChange',
              input: gameAgainstEagles(teamA, seasonA, 22, 'May')
            },
            {
              name: 'confirmChange',
              input: gameAgainstEagles(teamA, seasonA, 29, 'May')
            },
            {
              name: 'confirmChange',
              input: gameAgainstEagles(teamA, seasonA, 5, 'June')
            }
          ],
          'I can schedule those three games.'
        ),
        text('Hold Confirm under the table to schedule all three games.')
      ]
    },
    {
      // The batch's note for its first game comes first.
      match:
        /^The user confirmed the change "Add a home game against Demo Eagles on Saturday 22 May/,
      rounds: [
        text(
          'Done: the three games against Demo Eagles, on 22 May, 29 May and 5 June at 10:00, are on the schedule.'
        )
      ]
    },
    {
      match:
        /^The user confirmed the change "Add a home game against Demo Eagles on Saturday 12 June/,
      rounds: [
        text(
          'Done: the game against Demo Eagles on Saturday 12 June at 10:00 is on the schedule.'
        )
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
      // Slow enough to stop: a piece every 400 ms, for about ten seconds.
      match: /plan the whole season/i,
      rounds: [
        {
          ...text(
            'Here is a plan for the whole season, week by week. In the first week the team practises fielding on Monday and batting on Wednesday, then plays Demo Eagles at home on Saturday. In the second week the team rests on Monday, practises base running on Wednesday and plays away on Saturday. In the third week the pitchers throw on Tuesday and the team scrimmages on Thursday before a double header.'
          ),
          delayMs: 400
        }
      ]
    },
    {
      // Slower still, for the queue: a piece every 400 ms for over a minute,
      // long enough to queue, remove and edit messages under it.
      match: /write the season newsletter/i,
      rounds: [{ ...text(NEWSLETTER), delayMs: 400 }]
    },
    {
      match: /one more game against demo eagles/i,
      rounds: [
        tool(
          'confirmChange',
          gameAgainstEagles(teamA, seasonA, 12, 'June'),
          'I can add that game for you.'
        ),
        text('Hold Confirm under the table to add the game on 12 June.')
      ]
    },
    {
      match: /which field do we use in june/i,
      rounds: [text('In June the home games are on Demo Field.')]
    },
    {
      match: /and the playoffs too/i,
      rounds: [
        text('Both together: the regular season first, then the playoffs.')
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

/**
 * Each video's HLS, from one generated H.264 clip any browser plays, in a
 * media root: where a fixture's `local` video rows find their files.
 */
export async function makeMedia(
  mediaRoot: string,
  ids: string[]
): Promise<void> {
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
  // Each answer writes to the cache and reads from it, in counts unlike its
  // fresh input, so a count stored in the wrong column shows.
  const model = await fakeAnthropic({ cacheTokens: { write: 300, read: 900 } })
  // The server's operational log, kept here rather than sent.
  const logged: Array<{ E: string; L: string; P: Record<string, unknown> }> = []
  const logDirectory = await mkdtemp(join(tmpdir(), 'tess-log-'))
  const stopLogging = startServerLogging({
    dsn: 'https://public@logs.example.test/1',
    directory: logDirectory,
    role: 'server',
    send: message => {
      logged.push((message as { event: (typeof logged)[number] }).event)
    }
  })
  let origin = ''
  const reads = await slowReads(() => origin)
  // No dot directory on the way, which `sendFile` would refuse.
  const mediaRoot = await mkdtemp(join(tmpdir(), 'tess-media-'))
  const videos = { firstBase: 'vid_tess_first', homePlate: 'vid_tess_home' }
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
            origin: () => reads.origin,
            ...(options.keepAliveMs == null
              ? {}
              : { keepAliveMs: options.keepAliveMs })
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
    // Tony Gwynn on Demo Hawks; Ozzie Smith on a team user 101 cannot see.
    const players = {
      visible: userIdOfGumbo(107),
      hidden: userIdOfGumbo(108)
    }
    for (const [id, name, team] of [
      [107, 'Tony Gwynn', f.teamA],
      [108, 'Ozzie Smith', f.standaloneTeam]
    ] as const) {
      await insertFixtureUsers(db, {
        id,
        legacyId: `usr_tess_${id}`,
        display_name: name,
        first_name: name.split(' ')[0],
        last_name: name.split(' ')[1],
        login_enabled: false
      })
      await db
        .insertInto('memberships')
        .values({
          id: `mem_tess_${id}`,
          user_id: userIdOfGumbo(id),
          team_id: team,
          role: 'member',
          is_player: true,
          jersey: id === 107 ? '19' : '1',
          positions: ['SS']
        })
        .execute()
    }
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
      // Tess is on in this fixture, as the server's scopes say where she is.
      scopes: dictationScopes({ tess: true }),
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
        players,
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
      players,
      tessRequests: () => logged.filter(row => row.E === 'tess_request'),
      close: async () => {
        detach?.()
        await stopLogging()
        await rm(logDirectory, { recursive: true, force: true })
        await fixture.h.close()
        await model.close()
        reads.server.close()
        reads.server.closeAllConnections()
        await rm(mediaRoot, { recursive: true, force: true })
      }
    }
  } catch (error) {
    detach?.()
    await stopLogging()
    await rm(logDirectory, { recursive: true, force: true })
    await f?.h.close().catch(() => undefined)
    await model.close().catch(() => undefined)
    reads.server.close()
    await rm(mediaRoot, { recursive: true, force: true })
    throw error
  }
}
