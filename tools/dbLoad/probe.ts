import { sql } from 'kysely'
import { WebSocket } from 'ws'

import { Scorekeeper, request, Tally } from './actors'
import { type LoadDatabase } from './database'
import type { SeededAccount, TokensFile } from './fixture'

/**
 * One worst-case account at a time, with nothing else running: what each thing
 * it does costs the database. It reads `pg_stat_statements` before and after,
 * so another client's statements would count too, which is why these run alone.
 */

export interface ProbeResult {
  account: string
  probe: string
  statements: number
  ms: number
  rows: number
  error?: string
}

async function statementTotals(
  db: LoadDatabase
): Promise<{ calls: number; rows: number }> {
  const { rows } = await sql<{ calls: string | null; rows: string | null }>`
    select sum(calls) as calls, sum(rows) as rows from pg_stat_statements
    where dbid = (select oid from pg_database where datname = current_database())
      and query not like '%pg_stat_statements%'
  `.execute(db)
  return { calls: Number(rows[0].calls ?? 0), rows: Number(rows[0].rows ?? 0) }
}

export async function measure(
  db: LoadDatabase,
  account: string,
  probe: string,
  work: () => Promise<unknown>
): Promise<ProbeResult> {
  const before = await statementTotals(db)
  const started = performance.now()
  let error: string | undefined
  try {
    await work()
  } catch (caught) {
    error = (caught as Error).message
  }
  const ms = performance.now() - started
  const after = await statementTotals(db)
  return {
    account,
    probe,
    statements: after.calls - before.calls,
    ms,
    rows: after.rows - before.rows,
    ...(error == null ? {} : { error })
  }
}

/** Opens a socket, subscribes to a game, and waits for the answer. */
export async function socketSubscribe(
  server: string,
  token: string,
  gameId: string,
  timeoutMs = 10_000
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${server.replace(/^http/, 'ws')}/socket`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('The socket did not answer in time'))
    }, timeoutMs)
    const done = (error?: Error): void => {
      clearTimeout(timer)
      ws.close()
      if (error == null) resolve()
      else reject(error)
    }
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', gameId, id: 'probe' }))
    })
    ws.on('message', data => {
      const frame = JSON.parse(String(data)) as {
        type?: string
        message?: string
      }
      if (frame.type === 'subscribed') done()
      else if (frame.type === 'error')
        done(new Error(frame.message ?? 'refused'))
    })
    ws.on('error', error => {
      done(error)
    })
  })
}

/** The screens an account opens, as one probe each. */
export async function probeAccount(
  db: LoadDatabase,
  server: string,
  account: SeededAccount,
  tokens: Pick<TokensFile, 'games'>
): Promise<ProbeResult[]> {
  const game = tokens.games[account.gameIndex ?? 0]
  const results: ProbeResult[] = []
  const probe = async (
    name: string,
    work: () => Promise<unknown>
  ): Promise<void> => {
    results.push(await measure(db, account.label, name, work))
  }
  const read = async (path: string, route: string): Promise<void> => {
    await probe(`GET ${route}`, async () => {
      await request(server, account, 'GET', path)
    })
  }
  await read('/me/roles', '/me/roles')
  await probe('socket subscribe', async () => {
    await socketSubscribe(server, account.token, game.id)
  })
  if (account.teamId != null) {
    await read(`/teams/${account.teamId}/roster`, '/teams/:id/roster')
    await read(`/teams/${account.teamId}/stats`, '/teams/:id/stats')
    await read(`/teams/${account.teamId}/games`, '/teams/:id/games')
  }
  await read(`/seasons/${game.seasonId}/standings`, '/seasons/:id/standings')
  await read('/chat/conversations', '/chat/conversations')
  return results
}

/** Scores one pitch in the long game, which replays all of it. */
export async function probeLongGame(
  db: LoadDatabase,
  server: string,
  tokens: Pick<TokensFile, 'accounts' | 'games'>
): Promise<ProbeResult> {
  const game = tokens.games[1]
  const scorer = tokens.accounts.find(
    account => account.label === game.scorekeeper
  )
  if (scorer == null) throw new Error('The long game has no scorekeeper')
  const keeper = new Scorekeeper(server, scorer, game, new Tally(), 1000)
  try {
    await keeper.open()
    return await measure(
      db,
      scorer.label,
      'score one pitch in the long game',
      async () => {
        await keeper.pitch()
      }
    )
  } finally {
    keeper.stop()
  }
}

/** Every worst-case account in turn, then the long game. */
export async function runProbes(
  db: LoadDatabase,
  server: string,
  tokens: TokensFile
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (const account of tokens.accounts.filter(row => row.kind === 'worstCase'))
    results.push(...(await probeAccount(db, server, account, tokens)))
  results.push(await probeLongGame(db, server, tokens))
  return results
}

export function renderProbes(results: ProbeResult[]): string {
  return `${results
    .map(
      row =>
        `${row.account}  ${row.probe}: ${row.statements} statements, ${row.ms.toFixed(1)} ms, ${row.rows} rows${row.error == null ? '' : `, failed: ${row.error}`}`
    )
    .join('\n')}\n`
}
