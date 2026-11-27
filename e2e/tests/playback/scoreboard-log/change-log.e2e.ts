import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { stackSql } from '../../../rigs/coach/coachApp'
import { seedBoards } from '../scoreboard-server/boardSockets'
import { changeBoardEveryWay, logVersion } from './boardChanges'

/**
 * The old E2: every change to a game's board that is not TeamStation scoring
 * is logged, and scoring is not. The publisher, the dashboard and a scorer
 * change the stack's board over its own sockets and API; the game's
 * scoreboard log is read back from the stack's database.
 */

async function nonScoringChangesLogged(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const gameId = boards.games['-10m']
  const lines: string[] = []
  const say = (line: string): void => {
    lines.push(`+${((Date.now() - started) / 1000).toFixed(2)}s  ${line}`)
  }
  const started = Date.now()
  try {
    // Only this scenario's rows: any the game already had are left out.
    const from = await logVersion(ctx, gameId)
    const { heard, before } = await changeBoardEveryWay(
      ctx,
      boards,
      gameId,
      say
    )
    const { rows } = await stackSql(
      ctx,
      `select version, at, cause, actor_id, publisher, overrides
        from scoreboard_log where game_id = $1 and version > $2 order by version`,
      [gameId, from]
    )
    say(`${rows.length} rows in scoreboard_log`)
    for (const row of rows as Array<Record<string, any>>) {
      lines.push(
        `  ${row.version}  ${row.at}  ${String(row.cause).padEnd(9)}  ${row.actor_id == null ? 'null' : 'actor'}  ${JSON.stringify(row.publisher)}  count override ${row.overrides?.overrideCountEnabled === true ? 'on' : 'off'}`
      )
    }
    const typed = rows as Array<{
      cause: string
      actor_id: string | null
      publisher: { receivedAt?: number } | null
    }>
    expect(
      typed.map(row => row.cause),
      'publisher, publisher, publisher (speed), speedHold, dashboard, reset; no row for the unchanged overrides or the scoring post'
    ).deep.equals([
      'publisher',
      'publisher',
      'publisher',
      'speedHold',
      'dashboard',
      'reset'
    ])
    const receivedAt = typed.slice(0, 2).map(row => row.publisher?.receivedAt)
    expect(receivedAt[1], 'the repeat moved receivedAt').greaterThan(
      receivedAt[0]!
    )
    expect(
      typed[2].publisher?.receivedAt,
      'the speed alone keeps the contested receivedAt'
    ).equals(receivedAt[1])
    expect(typed[3].actor_id, 'the speed hold has no actor').equals(null)
    expect(typed[5].publisher, 'the reset clears the publisher').equals(null)
    expect(
      heard.at(-1)?.balls,
      'the scoring post drew one ball more than the reset board'
    ).equals((before?.balls ?? 0) + 1)
  } finally {
    writeFileSync(ctx.artifact('change-log.log'), `${lines.join('\n')}\n`)
  }
}

export default defineHarness({
  id: 'playback/scoreboard-log/change-log',
  title:
    'Every change to a board but scoring is logged, in order, and scoring is not',
  kind: 'e2e',
  covers: [
    'src/server/scoreboard/scoreboardLog.ts',
    'src/server/scoreboard/scoreboardHub.ts',
    'src/server/scoreboard/scoreboardStore.ts'
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
  minutes: 2,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'non-scoring-changes-logged': nonScoringChangesLogged
  }
})
