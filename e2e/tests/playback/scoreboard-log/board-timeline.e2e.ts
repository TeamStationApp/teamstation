import { writeFileSync } from 'node:fs'

import { expect } from 'chai'
import { WebSocket } from 'ws'

import { NO_OVERRIDES } from '../../../../src/common/scoreboard'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { stackSql } from '../../../rigs/coach/coachApp'
import { scoreboardSocketUrl } from '../../../rigs/scoreboardPublish'
import {
  apiOf,
  scoringSession,
  seedBoards,
  sleep
} from '../scoreboard-server/boardSockets'
import { changeBoardEveryWay, openSocket } from './boardChanges'

/**
 * The old E3: a game's board at any moment can be rebuilt from its
 * timeline, and a member listening is told when it changes. The game is
 * first changed every way E2 changes it (so its timeline holds scoring and
 * log steps), then a scorer, an undo and the dashboard write while a
 * `timeline=1` socket and a plain viewer listen, and the timeline is read
 * after each write.
 */

interface Step {
  at: number
  state: Record<string, any>
}

const short = (state: Record<string, any>): string =>
  `${state.awayTeam} ${state.awayScore} – ${state.homeTeam} ${state.homeScore}, ` +
  `${state.half} ${state.inning}, ${state.balls}-${state.strikes}, ${state.outs} out, ` +
  `bases ${[state.base1, state.base2, state.base3].map(on => (on === true ? 'x' : '-')).join('')}` +
  (state.pitchSpeed > 0 ? `, ${state.pitchSpeed} mph` : '')

/** What made each moment: the log's rows and the scorer's action times. */
async function sourcesOf(
  ctx: HarnessContext,
  gameId: string
): Promise<Map<number, string>> {
  const sources = new Map<number, string>()
  const plays = await stackSql(
    ctx,
    `select "atBatIndex", "endTime", gumbo->'teamStation'->'actionTimes' as times
      from events where "gameId" = $1`,
    [gameId]
  )
  for (const play of plays.rows as Array<Record<string, any>>) {
    if (play.endTime != null)
      sources.set(Date.parse(play.endTime), `play ${play.atBatIndex} end`)
    for (const time of (play.times ?? []) as string[])
      sources.set(Date.parse(time), `scoring (play ${play.atBatIndex})`)
  }
  const game = await stackSql(
    ctx,
    `select "currentPlay"->'teamStation'->'actionTimes' as times from games where id = $1`,
    [gameId]
  )
  for (const time of ((game.rows[0] as Record<string, any> | undefined)
    ?.times ?? []) as string[])
    sources.set(Date.parse(time), 'scoring (at-bat in progress)')
  const rows = await stackSql(
    ctx,
    'select at, cause from scoreboard_log where game_id = $1',
    [gameId]
  )
  for (const row of rows.rows as Array<Record<string, any>>)
    sources.set(Date.parse(row.at), `log: ${row.cause}`)
  return sources
}

async function timelineAndNotices(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const token = boards.runner
  const gameId = boards.games['-10m']
  const lines: string[] = []
  const started = Date.now()
  const say = (line: string): void => {
    lines.push(`+${((Date.now() - started) / 1000).toFixed(2)}s  ${line}`)
  }
  const timeline = async (
    query: string,
    auth = true
  ): Promise<{ status: number; json: any }> => {
    const url = `${apiOf(ctx)}/games/${encodeURIComponent(gameId)}/scoreboard-timeline${query}`
    say(`$ GET ${url.replace(/^https?:\/\/[^/]+/, '<stack>')}`)
    const answer = await fetch(url, {
      headers: auth ? { authorization: `Bearer ${token}` } : {}
    })
    const text = await answer.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: answer.status, json }
  }
  const printSteps = async (steps: Step[]): Promise<void> => {
    const sources = await sourcesOf(ctx, gameId)
    for (const step of steps)
      lines.push(
        `  ${new Date(step.at).toISOString()}  ${(sources.get(step.at) ?? '?').padEnd(30)}  ${short(step.state)}`
      )
  }
  const sockets: WebSocket[] = []
  try {
    await changeBoardEveryWay(ctx, boards, gameId, say)

    // 1. The timeline as it stands.
    const first = await timeline('')
    expect(first.status).equals(200)
    say(`${first.json.version} version, ${first.json.steps.length} steps`)
    await printSteps(first.json.steps)
    const ats = (first.json.steps as Step[]).map(step => step.at)
    expect(
      ats.every((at, i) => i === 0 || at > ats[i - 1]),
      'the steps are in time order'
    ).equals(true)
    const sources = await sourcesOf(ctx, gameId)
    const kinds = (first.json.steps as Step[]).map(step =>
      (sources.get(step.at) ?? '').startsWith('log') ? 'log' : 'scoring'
    )
    expect(kinds, 'they interleave scoring and log changes')
      .include('log')
      .and.include('scoring')

    // 2. Listeners, then writers.
    const notices: Array<{ at: number; text: string }> = []
    const listener = await openSocket(
      ctx,
      gameId,
      'socket?timeline=1',
      token,
      text => {
        notices.push({ at: Date.now(), text })
        say(`timeline socket heard ${text}`)
      }
    )
    sockets.push(listener)
    const plain: string[] = []
    const viewer = await openSocket(ctx, gameId, 'socket', token, text => {
      plain.push(text)
    })
    sockets.push(viewer)
    await sleep(500)

    /** Waits for the next notice and says how long it took. */
    const nextNotice = async (after: number, count: number): Promise<void> => {
      const deadline = Date.now() + 5000
      while (notices.length < count && Date.now() < deadline) await sleep(10)
      const notice = notices[count - 1]
      const ms = notice == null ? Infinity : notice.at - after
      expect(notice?.text, `notice ${count}`).equals('{"type":"changed"}')
      expect(
        ms,
        `a change notice within 1 s (notice ${count})`
      ).lessThanOrEqual(1000)
    }

    const session = await scoringSession(ctx, token, gameId)
    const before = (await timeline(`?from=${started - 60_000}`)).json
      .steps as Step[]

    say('scorer posts a strike')
    const strikeAt = Date.now()
    session.apply({ type: 'pitch', call: 'S' })
    await session.flush()
    await nextNotice(strikeAt, 1)
    const struck = await timeline(`?from=${strikeAt - 60_000}`)
    await printSteps(struck.json.steps)
    const strikeStep = (struck.json.steps as Step[]).find(
      step => step.at >= strikeAt
    )
    expect(
      strikeStep?.state.strikes,
      'the refetched timeline holds the strike'
    ).equals(before.at(-1)!.state.strikes + 1)

    say('scorer undoes it')
    const undoAt = Date.now()
    session.undo()
    await session.flush()
    await nextNotice(undoAt, 2)
    const undone = await timeline(`?from=${strikeAt - 60_000}`)
    await printSteps(undone.json.steps)
    expect(
      (undone.json.steps as Step[]).some(step => step.at === strikeStep?.at),
      'the refetched timeline no longer holds the undone strike'
    ).equals(false)
    expect(
      JSON.stringify((undone.json.steps as Step[]).at(-1)!.state),
      'and ends on the board from before it'
    ).equals(JSON.stringify(before.at(-1)!.state))

    // The dashboard.
    const dashboard = await openSocket(ctx, gameId, 'dashboard', token)
    sockets.push(dashboard)
    const inning = {
      ...NO_OVERRIDES,
      overrideInningEnabled: true,
      overrideInning: { inning: 7, half: 'bottom' }
    }
    say('dashboard turns the inning override on')
    const onAt = Date.now()
    dashboard.send(JSON.stringify({ type: 'overrides', data: inning }))
    await nextNotice(onAt, 3)
    const on = await timeline(`?from=${onAt - 1000}`)
    await printSteps(on.json.steps)
    const onLast = (on.json.steps as Step[]).at(-1)!.state
    expect(
      { inning: onLast.inning, half: onLast.half },
      'the refetched timeline holds the override'
    ).deep.equals({ inning: 7, half: 'bottom' })
    await sleep(1100)
    say('dashboard turns it off')
    const offAt = Date.now()
    dashboard.send(
      JSON.stringify({
        type: 'overrides',
        data: { ...inning, overrideInningEnabled: false }
      })
    )
    await nextNotice(offAt, 4)
    const off = await timeline(`?from=${offAt - 1000}`)
    await printSteps(off.json.steps)
    dashboard.close(1000)

    // 3. The end state.
    await sleep(500)
    const whole = await timeline('')
    say(`${whole.json.version} version, ${whole.json.steps.length} steps`)
    await printSteps(whole.json.steps)
    const live = await fetch(
      `${apiOf(ctx)}/scoreboard/${encodeURIComponent(gameId)}`
    )
    const liveState = ((await live.json()) as { state: unknown }).state
    expect(
      JSON.stringify((whole.json.steps as Step[]).at(-1)!.state),
      'the last step is the board GET /scoreboard/<G> draws'
    ).equals(JSON.stringify(liveState))

    lines.push(`plain socket heard ${plain.length} messages:`)
    for (const text of plain) lines.push(`  ${text}`)
    expect(
      plain.length,
      'the plain socket was sent a bare board on opening and after each of the four writes'
    ).equals(5)
    expect(
      plain.every(text => {
        const board = JSON.parse(text)
        return board.type === undefined && typeof board.inGame === 'boolean'
      }),
      'and no notice'
    ).equals(true)
    expect(
      plain.at(-1),
      'its last board is byte for byte the live board'
    ).equals(JSON.stringify(liveState))
    expect(
      notices.length,
      'the timeline socket heard one notice per write'
    ).equals(4)

    const anonymous = await timeline('', false)
    expect(anonymous.status, 'no token is 401').equals(401)
    const unsigned = new WebSocket(
      `${scoreboardSocketUrl(ctx.stack.origin, gameId, 'socket')}?timeline=1`
    )
    unsigned.on('error', () => undefined)
    const unsignedCode = await new Promise(resolve => {
      unsigned.once('close', resolve)
    })
    expect(unsignedCode, 'a timeline socket without a token is 4401').equals(
      4401
    )
  } finally {
    for (const socket of sockets) socket.close(1000)
    writeFileSync(ctx.artifact('board-timeline.log'), `${lines.join('\n')}\n`)
  }
}

export default defineHarness({
  id: 'playback/scoreboard-log/board-timeline',
  title:
    'A board’s timeline rebuilds it at any moment, and a member listening is told of each change',
  kind: 'e2e',
  covers: [
    'src/server/scoreboard/boardTimeline.ts',
    'src/server/scoreboard/scoreboardHub.ts',
    'src/server/routes/scoreboard.ts'
  ],
  stack: 'isolated',
  fixtures: ['scoreboard-games'],
  exclusive: false,
  surfaces: {
    // Sockets, the API and the stack's database only: no page is opened.
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 3,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'timeline-and-notices': timelineAndNotices,
    'listeners-and-writers-on-two-workers': async () => {
      throw new BlockedError(
        "the timeline socket on one API worker and the scorer and dashboard on the other: the stack is reached through Caddy and the fault server, so no connection is held to a worker, and nothing it serves says which worker holds a socket (the old check read the server's own connection table)"
      )
    }
  }
})
