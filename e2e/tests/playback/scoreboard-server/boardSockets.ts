import { expect } from 'chai'
import { WebSocket } from 'ws'

import type { ScoreboardState } from '../../../../src/common/scoreboard'
import type { FixtureManifest } from '../../../../src/server/dev/fixtures/accounts'
import type { HarnessContext } from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'
import { tokenOf } from '../../../rigs/eventWeb'
import { scoreboardSocketUrl } from '../../../rigs/scoreboardPublish'

/**
 * What the scoreboard scenarios share: the `scoreboard-games` world on the
 * stack with its two people signed in, viewer sockets on a game's board, and
 * reads of the stack's API. Every socket is the stack's own, over wss, as a
 * viewer's browser and TS Watcher open them.
 */

/** The world's games by the names the old seeder printed them under. */
export type GameName =
  '-4h' | '-10m' | '+1h' | '+2h' | '+3h' | '+4h' | '+5h' | '+6h' | 'cancelled'

const IDS: Record<GameName, string> = {
  '-4h': 'minus4h',
  '-10m': 'minus10m',
  '+1h': 'plus1h',
  '+2h': 'plus2h',
  '+3h': 'plus3h',
  '+4h': 'plus4h',
  '+5h': 'plus5h',
  '+6h': 'plus6h',
  cancelled: 'cancelled'
}

export interface Boards {
  world: FixtureManifest
  games: Record<GameName, string>
  /** The runner's session: the home team's owner and scorekeeper. */
  runner: string
  /** A plain member of the home team, who runs nothing. */
  other: string
  homeTeam: string
  awayTeam: string
}

export const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export async function until<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(25)
  }
}

/** The stack's API base. */
export function apiOf(ctx: HarnessContext): string {
  return `${ctx.stack.origin.replace(/\/+$/, '')}/api/v1`
}

/** Seeds this scenario's games and signs both people in through the API. */
export async function seedBoards(ctx: HarnessContext): Promise<Boards> {
  const world = await ctx.fixture('scoreboard-games')
  await clearSignInLimits(ctx)
  const games = Object.fromEntries(
    Object.entries(IDS).map(([name, key]) => [name, world.ids[key]])
  ) as Record<GameName, string>
  for (const [name, id] of Object.entries(games))
    expect(id, `the world's ${name} game`).a('string')
  return {
    world,
    games,
    runner: await tokenOf(ctx, world.accounts.runner),
    other: await tokenOf(ctx, world.accounts.other),
    homeTeam: world.ids.homeTeamName,
    awayTeam: world.ids.awayTeamName
  }
}

/** A viewer socket and everything it has been sent. */
export interface Viewer {
  socket: WebSocket
  states: ScoreboardState[]
  times: number[]
  close?: number
  open: Promise<void>
}

/** A viewer on the game's board socket, as the board page opens it. */
export function view(ctx: HarnessContext, gameId: string): Viewer {
  const socket = new WebSocket(
    scoreboardSocketUrl(ctx.stack.origin, gameId, 'socket')
  )
  const viewer: Viewer = {
    socket,
    states: [],
    times: [],
    open: new Promise(resolve =>
      socket.once('open', () => {
        resolve()
      })
    )
  }
  socket.on('message', data => {
    viewer.states.push(JSON.parse((data as Buffer).toString('utf8')))
    viewer.times.push(Date.now())
  })
  socket.on('close', code => {
    viewer.close = code
  })
  socket.on('error', () => undefined)
  return viewer
}

export const latest = (viewer: Viewer): ScoreboardState | undefined =>
  viewer.states.at(-1)

/** A GET on the stack's API, as `token` or nobody: its status and body. */
export async function getJson(
  ctx: HarnessContext,
  path: string,
  token?: string
): Promise<{ status: number; body: any }> {
  const answer = await fetch(`${apiOf(ctx)}${path}`, {
    headers: token == null ? {} : { authorization: `Bearer ${token}` }
  })
  const text = await answer.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: answer.status, body }
}

/** A publisher socket, open and signed in, and when its partial went. */
export async function publishAt(
  ctx: HarnessContext,
  gameId: string,
  token: string,
  partial: Record<string, unknown>
): Promise<{ sentAt: number; done: () => void }> {
  const socket = new WebSocket(
    scoreboardSocketUrl(ctx.stack.origin, gameId, 'publish'),
    { headers: { authorization: `Bearer ${token}` } }
  )
  socket.on('error', () => undefined)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('close', code => {
      reject(new Error(`publish socket closed ${code}`))
    })
  })
  const sentAt = Date.now()
  socket.send(JSON.stringify(partial))
  return {
    sentAt,
    done: () => {
      socket.close()
    }
  }
}

/**
 * Opens a scoring session on the game the way the app does, through the
 * API: `fetchFn` is what the client sends with.
 */
export async function scoringSession(
  ctx: HarnessContext,
  token: string,
  gameId: string
): Promise<{
  apply: (action: { type: 'pitch'; call: string }) => void
  undo: () => void
  flush: () => Promise<void>
}> {
  const { TeamStationClient } = await import('../../../../src/common/api')
  const { ScoringSession } =
    await import('../../../../src/common/scoring/session')
  const { startingSetup, teamsOf } =
    await import('../../../../src/common/scoring/startingSetup')
  const client = new TeamStationClient({ baseUrl: apiOf(ctx), token })
  const game = await client.game(gameId)
  const [away, home] = await Promise.all([
    client.roster(game.awayTeamId),
    client.roster(game.homeTeamId)
  ])
  const session = await ScoringSession.open(
    {
      load: async id => await client.gameEvents(id),
      save: async (id, change) => await client.saveGameEvents(id, change)
    },
    gameId,
    {
      gamePk: gameId,
      teams: teamsOf(game),
      setup: startingSetup(game, away, home)
    },
    { setTimer: () => null, clearTimer: () => undefined }
  )
  return {
    apply: action => {
      const problems = session.apply(action as never).problems
      if (problems.length > 0) throw new Error(problems[0].message)
    },
    undo: () => {
      session.undo()
    },
    flush: async () => {
      await session.flush()
    }
  }
}
