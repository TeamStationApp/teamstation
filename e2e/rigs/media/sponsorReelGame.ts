import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import type { Kysely } from 'kysely'

import { TeamStationClient } from '../../../src/common/api'
import type { ScoringAction } from '../../../src/common/scoring/actions'
import { newSetup } from '../../../src/common/scoring/lineup'
import {
  type EventStore,
  ScoringSession
} from '../../../src/common/scoring/session'
import type { GameSponsors } from '../../../src/common/sponsors/types'
import { type Database, makeDatabase } from '../../../src/server/db/database'
import type { FixtureManifest } from '../../../src/server/dev/fixtures/accounts'
import { nodeDatabaseUrl } from '../../core/dropletStack'
import { eventually } from '../../core/readback'
import type { E2eContext, WebSession } from '../../core/spec'
import type { DropletPublisher } from '../streaming/dropletPublisher'
import { apiToken } from './recordingSeek'
import { publishGame, syntheticClipArgs } from './sponsorRecordings'
import { stackHandle } from './stackSpace'

/**
 * The sponsor reel scenarios' game (#220): the `sponsors` world's Yankees @
 * Red Sox, its official start a moment ahead, published live from the
 * stack's publisher droplet, the American League with a 12-second reel, and
 * a scorer posting through the API as the scoring screen does. Shared by
 * `playback/sponsors/reels` and `playback/sponsors/tv`.
 */

const run = promisify(execFile)
const ffmpeg = (): string => process.env.TS_FFMPEG ?? 'ffmpeg'

export const REEL_MS = 12_000

export interface ReelSetup {
  world: FixtureManifest
  league: string
  gameId: string
  /** The AL admin (who films and scores) and the Yankees player. */
  admin: TeamStationClient
  player: TeamStationClient
  db: Kysely<Database>
  /** The stack's database as `psql` takes it, which holds a password. */
  psqlUrl: string
}

/** The world, its clients and the stack's database. */
export async function reelWorld(ctx: E2eContext): Promise<ReelSetup> {
  const handle = stackHandle(ctx)
  const manifest = await ctx.fixture('sponsors')
  return {
    world: manifest,
    league: manifest.ids.americanLeague,
    gameId: manifest.ids.yankeesAtRedSox,
    admin: new TeamStationClient({
      baseUrl: handle.api,
      token: await apiToken(handle.api, manifest.accounts.alAdmin)
    }),
    player: new TeamStationClient({
      baseUrl: handle.api,
      token: await apiToken(handle.api, manifest.accounts.yankeesPlayer)
    }),
    db: makeDatabase(nodeDatabaseUrl(handle.databaseUrl)),
    psqlUrl: handle.databaseUrl
  }
}

/**
 * The AL admin accepts a 12-second 640 × 360 reel of 100 broadcasts through
 * the API: the synthetic pattern with its own tone. Answers its id.
 */
export async function acceptReel(
  ctx: E2eContext,
  setup: ReelSetup
): Promise<string> {
  const file = ctx.artifact('reel.mp4')
  await run(ffmpeg(), syntheticClipArgs(REEL_MS / 1000, file, 880), {
    maxBuffer: 1 << 24
  })
  const media = await setup.admin.uploadSponsorMedia(
    setup.league,
    'reel',
    'video/mp4',
    new Uint8Array(readFileSync(file))
  )
  const state = await setup.admin.addSponsorReel(setup.league, {
    mediaId: media.mediaId,
    name: 'Harbor Bank 12s',
    allocation: 100
  })
  const reel = state.reels.find(one => one.name === 'Harbor Bank 12s')
  expect(reel, 'the accepted reel').not.equals(undefined)
  return reel!.id
}

/**
 * The AL admin accepts a 480 × 120 logo of 50 games through the API, on a
 * transparent ground. Answers its id. Accepted before the game is recorded,
 * so the game is given it.
 */
export async function acceptLogo(
  ctx: E2eContext,
  setup: ReelSetup
): Promise<string> {
  const file = ctx.artifact('logo.png')
  await run(ffmpeg(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x00000000:s=480x120,format=rgba',
    '-vf',
    'drawbox=x=12:y=12:w=456:h=96:color=yellow:t=8:replace=1,drawbox=x=40:y=40:w=400:h=40:color=red:t=fill:replace=1',
    '-frames:v',
    '1',
    file
  ])
  const media = await setup.admin.uploadSponsorMedia(
    setup.league,
    'logo',
    'image/png',
    new Uint8Array(readFileSync(file))
  )
  const state = await setup.admin.addSponsorLogo(setup.league, {
    mediaId: media.mediaId,
    name: 'Harbor Bank',
    allocation: 50
  })
  const logo = state.logos.find(one => one.name === 'Harbor Bank')
  expect(logo, 'the accepted logo').not.equals(undefined)
  return logo!.id
}

/** A team's first nine players with their scoring ids, as a lineup takes them. */
async function rosterOf(
  setup: ReelSetup,
  teamId: string,
  label: string
): Promise<
  Array<{ userId: string; gumboId: number; shortName: string; jersey: string }>
> {
  const rows = await setup.db
    .selectFrom('memberships')
    .innerJoin('gumbo_ids', 'gumbo_ids.user_id', 'memberships.user_id')
    .select(['memberships.user_id as userId', 'gumbo_ids.gumbo_id as gumboId'])
    .where('memberships.team_id', '=', teamId)
    .where('memberships.is_player', '=', true)
    .orderBy('memberships.user_id')
    .limit(9)
    .execute()
  expect(rows, `nine ${label} players`).length(9)
  return rows.map((row, i) => ({
    userId: row.userId,
    gumboId: row.gumboId,
    shortName: `${label} ${i + 1}`,
    jersey: String(i + 1)
  }))
}

/** The scorer: the AL admin's scoring session on the game, posting as the app does. */
export interface Scorer {
  /** Three strikeouts: the half ends. Answers when its last post was answered. */
  endHalf: () => Promise<number>
  /** Takes the last batter back whole: a remove post. */
  undoBatter: () => Promise<number>
}

export async function scorer(setup: ReelSetup): Promise<Scorer> {
  const { admin, gameId, world } = setup
  const game = await admin.game(gameId)
  const teams = {
    away: { id: world.ids.yankees, name: game.awayTeamName ?? 'Yankees' },
    home: { id: world.ids.redSox, name: game.homeTeamName ?? 'Red Sox' }
  }
  const lineup = newSetup(teams, {
    away: await rosterOf(setup, world.ids.yankees, 'Yankees'),
    home: await rosterOf(setup, world.ids.redSox, 'Red Sox')
  })
  const store: EventStore = {
    load: async id => await admin.gameEvents(id),
    save: async (id, change, handoff) =>
      await admin.saveGameEvents(id, change, handoff)
  }
  const session = await ScoringSession.open(
    store,
    gameId,
    { gamePk: gameId, teams, setup: lineup },
    { setTimer: () => null, clearTimer: () => undefined }
  )
  const strike: ScoringAction = { type: 'pitch', call: 'C' }
  const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
  const apply = async (action: ScoringAction): Promise<void> => {
    const applied = session.apply(action)
    // A close the session made itself already is no problem.
    if (applied.problems.length > 0 && action !== close)
      throw new Error(applied.problems[0].message)
    await session.flush()
    if (session.problem != null) throw new Error(String(session.problem))
  }
  return {
    endHalf: async () => {
      for (let batter = 0; batter < 3; batter++)
        for (const action of [strike, strike, strike, close])
          await apply(action)
      return Date.now()
    },
    undoBatter: async () => {
      for (let undone = 0; undone < 4; undone++) session.undo()
      await session.flush()
      if (session.problem != null) throw new Error(String(session.problem))
      return Date.now()
    }
  }
}

/** The game's live videos once its cameras have published, by label. */
export async function liveVideos(
  setup: ReelSetup,
  count = 4
): Promise<string[]> {
  let ids: string[] = []
  await eventually(async () => {
    ids = (
      await setup.db
        .selectFrom('videos')
        .select('id')
        .where('game_id', '=', setup.gameId)
        .where('status', '=', 'live')
        .where('hidden', '=', false)
        .orderBy('title')
        .execute()
    ).map(row => row.id)
    expect(ids.length, `${count} live cameras`).equals(count)
  }, 120_000)
  return ids
}

/**
 * Moves the game's official start to `inMs` from now (the schedule API moves
 * only games another system scheduled), and publishes its four cameras.
 */
export async function goLive(
  ctx: E2eContext,
  setup: ReelSetup,
  inMs: number
): Promise<{ startAt: Date; cameras: DropletPublisher[]; videos: string[] }> {
  const startAt = new Date(Date.now() + inMs)
  await setup.db
    .updateTable('games')
    .set({ start_at: startAt })
    .where('id', '=', setup.gameId)
    .execute()
  const cameras = await publishGame(stackHandle(ctx), {
    gameId: setup.gameId,
    token: setup.admin.token!,
    runDir: join(ctx.runDir, 'live')
  })
  return { startAt, cameras, videos: await liveVideos(setup) }
}

/**
 * Stops the cameras and ends each stream, so its recording is finished and
 * ready: stopping the publishers alone leaves the videos live for minutes.
 */
export async function endLive(
  setup: ReelSetup,
  cameras: DropletPublisher[]
): Promise<void> {
  for (const camera of cameras) await camera.stop().catch(() => undefined)
  const streams = await setup.admin.liveStreams(setup.gameId)
  for (const stream of [...streams.mine, ...streams.others])
    await setup.admin
      .endLiveStream(setup.gameId, stream.id)
      .catch(() => undefined)
  await eventually(async () => {
    const live = await setup.db
      .selectFrom('videos')
      .select('id')
      .where('game_id', '=', setup.gameId)
      .where('status', 'in', ['live', 'processing'])
      .where('hidden', '=', false)
      .execute()
    expect(live, 'every recording finished').length(0)
  }, 300_000)
}

/** The game's reels as its player reads them, once there are `count`. */
export async function reelsRead(
  setup: ReelSetup,
  count: number,
  withinMs = 60_000
): Promise<GameSponsors> {
  let answer: GameSponsors | undefined
  await eventually(async () => {
    answer = await setup.player.gameSponsors(setup.gameId)
    expect(answer.reels.length, `${count} reels placed`).at.least(count)
  }, withinMs)
  return answer!
}

/** The game's placements and half-inning ends as `psql` reads them, for the log. */
export async function readSlots(
  setup: ReelSetup,
  step: string,
  logFile: string,
  append: (file: string, text: string) => void
): Promise<void> {
  const game = setup.gameId.replace(/'/g, '')
  const queries = [
    `select league_id, reel_id, slot, inning, half, starts_at, duration_ms, placed_at from game_reel_placements where game_id = '${game}' order by starts_at, league_id`,
    `select inning, half, at_bat_index, state, fade_at, created_at from game_half_ends where game_id = '${game}' order by inning, half desc`,
    `select id, name, allocation, used from sponsor_reels where league_id = '${setup.league.replace(/'/g, '')}' order by position`
  ]
  let text = `\n## ${step} (${new Date().toISOString()})\n`
  for (const query of queries) {
    const { stdout } = await run('psql', [setup.psqlUrl, '-c', query]).catch(
      (error: unknown) => {
        const stderr = (error as { stderr?: string }).stderr
        throw new Error(`psql failed: ${stderr ?? 'no output'}`)
      }
    )
    text += `$ psql "$STACK_DATABASE_URL" -c "${query}"\n${stdout}`
  }
  append(logFile, text)
}

/** What the page's players are doing, every 100 ms, read and never changed. */
export interface PlayerSample {
  /** This Mac's clock, ms. */
  at: number
  /**
   * The game's sound: the heard picture's volume (only it is ever turned
   * down, so the lowest of them), and whether every picture is muted.
   */
  volume: number
  muted: boolean
  /** A reel drawn, where, and its own place and state. */
  reel: [number, number, number, number] | null
  reelTime: number | null
  reelPaused: boolean | null
  reelMuted: boolean | null
  board: boolean
}

/** Starts reading the page's players every 100 ms into `window.__reelSamples`. */
export async function startSampling(web: WebSession): Promise<void> {
  await web.page.evaluate(() => {
    const win = window as unknown as {
      __reelSamples: unknown[]
      __reelTimer?: number
    }
    win.__reelSamples = []
    if (win.__reelTimer != null) clearInterval(win.__reelTimer)
    win.__reelTimer = window.setInterval(() => {
      const holder = document.querySelector<HTMLElement>(
        '[data-testid="sponsor-reel"]'
      )
      const reelVideo = holder == null ? null : holder.querySelector('video')
      const games = [...document.querySelectorAll('video')].filter(
        video => video.closest('[data-testid="sponsor-reel"]') === null
      )
      const heard = games.filter(video => !video.muted)
      const volume =
        games.length === 0 ? 1 : Math.min(...games.map(v => v.volume))
      const box = holder == null ? null : holder.getBoundingClientRect()
      win.__reelSamples.push({
        at: Date.now(),
        volume,
        muted: heard.length === 0,
        reel: box == null ? null : [box.left, box.top, box.width, box.height],
        reelTime: reelVideo == null ? null : reelVideo.currentTime,
        reelPaused: reelVideo == null ? null : reelVideo.paused,
        reelMuted: reelVideo == null ? null : reelVideo.muted,
        board:
          document.querySelector('[data-testid="scoreboard-overlay"]') != null
      })
    }, 100)
  })
}

/** The samples so far. */
export async function samples(web: WebSession): Promise<PlayerSample[]> {
  return await web.page.evaluate(
    () => (window as unknown as { __reelSamples: PlayerSample[] }).__reelSamples
  )
}

/** The samples as the audio log has them: one line each. */
export function sampleLines(list: PlayerSample[], from: number): string {
  return list
    .map(
      one =>
        `${((one.at - from) / 1000).toFixed(1).padStart(7)}s volume=${one.volume.toFixed(2)} muted=${String(one.muted)} reel=${one.reel == null ? '-' : `${one.reelTime?.toFixed(2) ?? '?'}s${one.reelPaused === true ? ' paused' : ''}${one.reelMuted === true ? ' muted' : ''}`} board=${String(one.board)}`
    )
    .join('\n')
}

/**
 * A reel's window in the samples: the first sample the game went down, the
 * first at 0.2, the first with the reel drawn, the last with it, and the
 * first back at full after it.
 */
export function reelWindow(list: PlayerSample[]): {
  down: number
  low: number
  shown: number
  gone: number
  up: number
} | null {
  const shown = list.findIndex(one => one.reel != null)
  if (shown < 0) return null
  let gone = shown
  while (gone + 1 < list.length && list[gone + 1].reel != null) gone++
  let down = shown
  while (down > 0 && list[down - 1].volume < 0.999) down--
  const low = list.findIndex((one, i) => i >= down && one.volume <= 0.201)
  let up = gone + 1
  while (up < list.length && list[up].volume < 0.999) up++
  if (up >= list.length) return null
  return {
    down: list[down].at,
    low: low < 0 ? list[shown].at : list[low].at,
    shown: list[shown].at,
    gone: list[Math.min(gone + 1, list.length - 1)].at,
    up: list[up].at
  }
}
