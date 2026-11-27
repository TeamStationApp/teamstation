import { expect } from 'chai'
import { WebSocket } from 'ws'

import { NO_OVERRIDES } from '../../../../src/common/scoreboard'
import type { HarnessContext } from '../../../core/spec'
import { stackSql } from '../../../rigs/coach/coachApp'
import { scoreboardSocketUrl } from '../../../rigs/scoreboardPublish'
import {
  type Boards,
  scoringSession,
  sleep
} from '../scoreboard-server/boardSockets'

/**
 * The game's board changed every way but scoring, then by scoring, as the
 * old E2 changed it: a publisher (a contested packet, the same again a
 * second later, then a pitch speed alone, waiting out the server's
 * five-second speed hold), the dashboard (the count override on, the same
 * overrides again, a reset), and one pitch through the API. What each step
 * printed goes to `say`.
 */

type Board = Record<string, any>

/** One of the game's board sockets, open: signed in but for a plain viewer's. */
export async function openSocket(
  ctx: HarnessContext,
  gameId: string,
  kind: 'socket' | 'publish' | 'dashboard' | 'socket?timeline=1',
  token: string,
  onMessage: (text: string) => void = () => undefined,
  say: (line: string) => void = () => undefined
): Promise<WebSocket> {
  const url = `${scoreboardSocketUrl(ctx.stack.origin, gameId, 'socket').replace(/\/socket$/, '')}/${kind}`
  const socket = new WebSocket(url, {
    headers: kind === 'socket' ? {} : { authorization: `Bearer ${token}` }
  })
  socket.on('message', data => {
    onMessage((data as Buffer).toString('utf8'))
  })
  socket.on('close', (code, reason) => {
    if (code !== 1000 && code !== 1005)
      say(
        `${kind} socket closed ${JSON.stringify({ code, reason: String(reason) })}`
      )
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

/** The highest log version the game has, before a scenario writes. */
export async function logVersion(
  ctx: HarnessContext,
  gameId: string
): Promise<number> {
  const { rows } = await stackSql(
    ctx,
    'select coalesce(max(version), 0)::int as version from scoreboard_log where game_id = $1',
    [gameId]
  )
  return Number(rows[0]?.version ?? 0)
}

/**
 * Makes E2's changes on `gameId`, with a viewer listening throughout, and
 * answers what the viewer heard and the board it held before the pitch.
 */
export async function changeBoardEveryWay(
  ctx: HarnessContext,
  boards: Boards,
  gameId: string,
  say: (line: string) => void
): Promise<{ heard: Board[]; before: Board | undefined }> {
  const token = boards.runner
  const heard: Board[] = []
  const viewer = await openSocket(
    ctx,
    gameId,
    'socket',
    token,
    text => {
      const board = JSON.parse(text) as Board
      heard.push(board)
      say(
        `viewer heard ${JSON.stringify({ balls: board.balls, strikes: board.strikes, outs: board.outs, pitchSpeed: board.pitchSpeed })}`
      )
    },
    say
  )
  try {
    await sleep(500)

    // 1. The publisher.
    const publisher = await openSocket(
      ctx,
      gameId,
      'publish',
      token,
      text => {
        say(`publisher was told ${text}`)
      },
      say
    )
    const contested = { balls: 2, strikes: 1 }
    say(`publisher sends a contested packet ${JSON.stringify(contested)}`)
    publisher.send(JSON.stringify(contested))
    await sleep(1100)
    say('publisher sends it again')
    publisher.send(JSON.stringify(contested))
    await sleep(1100)
    say('publisher sends a pitch speed {"pitchSpeed":61}')
    publisher.send(JSON.stringify({ pitchSpeed: 61 }))
    say('waiting 6 s for the speed hold')
    await sleep(6000)
    publisher.close(1000)

    // 2. The dashboard.
    const dashboard = await openSocket(
      ctx,
      gameId,
      'dashboard',
      token,
      undefined,
      say
    )
    const overrides = {
      ...NO_OVERRIDES,
      overrideCountEnabled: true,
      overrideCount: { balls: 3, strikes: 2, outs: 1 }
    }
    say('dashboard turns the count override on')
    dashboard.send(JSON.stringify({ type: 'overrides', data: overrides }))
    await sleep(1100)
    say('dashboard sends the same overrides again')
    dashboard.send(JSON.stringify({ type: 'overrides', data: overrides }))
    await sleep(1100)
    say('dashboard resets the game')
    dashboard.send(JSON.stringify({ type: 'reset' }))
    await sleep(1100)
    dashboard.close(1000)

    // 3. A scoring post: one ball more than the board the reset drew.
    const before = heard.at(-1)
    say('scorer posts a ball')
    const session = await scoringSession(ctx, token, gameId)
    session.apply({ type: 'pitch', call: 'B' })
    await session.flush()
    await sleep(1500)
    expect(
      heard.length,
      'the viewer heard the board as it changed'
    ).greaterThan(0)
    return { heard, before }
  } finally {
    viewer.close(1000)
  }
}
