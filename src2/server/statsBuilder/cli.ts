import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'
import { owedCount } from './builder'
import { requestAllGameStats, requestGameStats } from './request'

export interface CliArgs {
  game?: string
  all?: boolean
  wait?: number
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--game') {
      args.game = argv[++i]
    } else if (arg === '--all') {
      args.all = true
    } else if (arg === '--wait') {
      const wait = Number(argv[++i])
      if (!Number.isFinite(wait)) {
        throw new Error('--wait must be a number of seconds')
      }
      args.wait = wait
    }
  }
  if (args.wait == null) args.wait = 120
  return args
}

export interface StatusSummary {
  built: number
  incomplete: number
  failed: number
  pending: number
  incompleteReasons: Array<{ detail: string; count: number }>
}

export async function summarizeStatuses(
  db: ReturnType<typeof makeDatabase>
): Promise<StatusSummary> {
  const rows = await db
    .selectFrom('game_stats_state')
    .select(['status', 'detail'])
    .execute()
  const summary: StatusSummary = {
    built: 0,
    incomplete: 0,
    failed: 0,
    pending: 0,
    incompleteReasons: []
  }
  const reasons = new Map<string, number>()
  for (const row of rows) {
    if (row.status === 'built') summary.built++
    else if (row.status === 'incomplete') {
      summary.incomplete++
      const detail = row.detail ?? '(no detail)'
      reasons.set(detail, (reasons.get(detail) ?? 0) + 1)
    } else if (row.status === 'failed') summary.failed++
    else if (row.status === 'pending') summary.pending++
  }
  summary.incompleteReasons = [...reasons.entries()]
    .map(([detail, count]) => ({ detail, count }))
    .sort((a, b) => b.count - a.count || a.detail.localeCompare(b.detail))
  return summary
}

export function formatSummary(summary: StatusSummary): string {
  const lines = [
    `built ${summary.built}, incomplete ${summary.incomplete}, failed ${summary.failed}, pending ${summary.pending}`
  ]
  for (const reason of summary.incompleteReasons) {
    lines.push(`${reason.count}\t${reason.detail}`)
  }
  return lines.join('\n')
}

export async function runStatsRequest(
  args: CliArgs,
  options: {
    databaseUrl?: string
    log?: (line: string) => void
    sleep?: (ms: number) => Promise<void>
  } = {}
): Promise<StatusSummary | null> {
  const log = options.log ?? (line => console.log(line))
  const sleep =
    options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  if (args.game == null && args.all !== true) {
    throw new Error('Pass --game <gameId> or --all')
  }
  if (args.game != null && args.all === true) {
    throw new Error('Pass only one of --game or --all')
  }

  const db = makeDatabase(options.databaseUrl ?? serverConfig.databaseUrl)
  try {
    if (args.game != null) {
      await requestGameStats(db, args.game)
      return null
    }

    await requestAllGameStats(db)
    const deadline = Date.now() + (args.wait ?? 120) * 1000
    while (Date.now() < deadline) {
      if ((await owedCount(db)) === 0) break
      await sleep(200)
    }
    const summary = await summarizeStatuses(db)
    log(formatSummary(summary))
    return summary
  } finally {
    await db.destroy()
  }
}

export async function runCliMain(argv: string[]): Promise<void> {
  await runStatsRequest(parseArgs(argv))
}

/* c8 ignore start */
if (require.main === module) {
  runCliMain(process.argv.slice(2)).catch(error => {
    console.error(error)
    process.exit(1)
  })
}
/* c8 ignore stop */
