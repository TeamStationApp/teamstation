import type { Client } from 'pg'

/** A mark on this tool's own statements, for leaving them out of its figures. */
const OWN = '/* dbload-sampler */'

/** Backends of one kind at a moment. */
export interface BackendCount {
  applicationName: string
  state: BackendState
  /** Reached through the pooler, by its address, rather than directly. */
  pooled: boolean
  count: number
}

export type BackendState =
  | 'active'
  | 'idle'
  | 'idle in transaction'
  | 'idle in transaction (aborted)'
  | 'fastpath function call'
  | 'disabled'
  | 'unknown'

const STATES: readonly BackendState[] = [
  'active',
  'idle',
  'idle in transaction',
  'idle in transaction (aborted)',
  'fastpath function call',
  'disabled'
]

export interface Sample {
  at: number
  backends: BackendCount[]
  /** Backends waiting on any lock. */
  lockWaiters: number
  /** Those waiting on `Lock:object`, which is where NOTIFY's commit lock shows. */
  objectLockWaiters: number
  oldestTransactionSeconds: number
  /** Totals since the sampler started; null without `pg_stat_statements`. */
  statements: { calls: number; totalMs: number } | null
}

export interface ActivityRow {
  application_name: string | null
  state: string | null
  client_addr: string | null
  count: string | number
}

/** A `pg_stat_activity` state, or `unknown` for one with none or a new one. */
export function backendState(state: string | null): BackendState {
  return STATES.includes(state as BackendState)
    ? (state as BackendState)
    : 'unknown'
}

/** `pg_stat_activity` rows, each classed by whether it came from the pooler. */
export function parseActivity(
  rows: ActivityRow[],
  poolerAddress?: string
): BackendCount[] {
  const merged = new Map<string, BackendCount>()
  for (const row of rows) {
    const applicationName = row.application_name ?? ''
    const state = backendState(row.state)
    const pooled = poolerAddress != null && row.client_addr === poolerAddress
    const key = `${applicationName}\u0000${state}\u0000${pooled}`
    const held = merged.get(key)
    if (held == null)
      merged.set(key, {
        applicationName,
        state,
        pooled,
        count: Number(row.count)
      })
    else held.count += Number(row.count)
  }
  return [...merged.values()]
}

export interface StatementRow {
  queryid: string
  query: string
  calls: string | number
  total_exec_time: string | number
  rows: string | number
}

export interface Statement {
  queryId: string
  query: string
  calls: number
  totalMs: number
  rows: number
}

/** What each statement did between two reads of `pg_stat_statements`. */
export function statementDeltas(
  before: StatementRow[],
  after: StatementRow[]
): Statement[] {
  const base = new Map(before.map(row => [String(row.queryid), row]))
  const deltas: Statement[] = []
  for (const row of after) {
    const was = base.get(String(row.queryid))
    const calls = Number(row.calls) - Number(was?.calls ?? 0)
    if (calls <= 0) continue
    deltas.push({
      queryId: String(row.queryid),
      query: row.query,
      calls,
      totalMs: Number(row.total_exec_time) - Number(was?.total_exec_time ?? 0),
      rows: Number(row.rows) - Number(was?.rows ?? 0)
    })
  }
  return deltas.sort((a, b) => b.totalMs - a.totalMs)
}

export interface TableRow {
  relname: string
  seq_scan: string | number
  n_live_tup: string | number
}

export interface SequentialScan {
  table: string
  scans: number
  rows: number
}

/** Tables large enough to matter that were scanned between two reads. */
export function sequentialScans(
  before: TableRow[],
  after: TableRow[],
  minRows = 1000
): SequentialScan[] {
  const base = new Map(before.map(row => [row.relname, row]))
  return after
    .map(row => ({
      table: row.relname,
      scans:
        Number(row.seq_scan) - Number(base.get(row.relname)?.seq_scan ?? 0),
      rows: Number(row.n_live_tup)
    }))
    .filter(row => row.scans > 0 && row.rows >= minRows)
    .sort((a, b) => b.scans * b.rows - a.scans * a.rows)
}

export interface SamplerOptions {
  /** A direct connection, already connected. */
  client: Pick<Client, 'query'>
  intervalMs?: number
  /** The pooler's address as Postgres sees it, to class backends by. */
  poolerAddress?: string
  /** Fail rather than report no statement figures. */
  requireStatements?: boolean
  onError?: (error: Error) => void
}

/** Reads the database's own views once a second, for the length of a run. */
export class Sampler {
  readonly samples: Sample[] = []
  hasStatements = false
  private timer: NodeJS.Timeout | undefined
  private reading = false
  private statementsBefore: StatementRow[] = []
  private statementsAfter: StatementRow[] = []
  private tablesBefore: TableRow[] = []
  private tablesAfter: TableRow[] = []

  constructor(private readonly options: SamplerOptions) {}

  async start(): Promise<void> {
    const { client, requireStatements } = this.options
    const found = await client.query(
      `${OWN} select 1 from pg_extension where extname = 'pg_stat_statements'`
    )
    this.hasStatements = found.rows.length > 0
    if (requireStatements === true && !this.hasStatements)
      throw new Error(
        '--require-statements: this database has no pg_stat_statements extension'
      )
    this.statementsBefore = await this.readStatements()
    this.tablesBefore = await this.readTables()
    await this.sample()
    this.timer = setInterval(() => {
      void this.sample()
    }, this.options.intervalMs ?? 1000)
  }

  async stop(): Promise<void> {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = undefined
    await this.sample()
    this.statementsAfter = await this.readStatements()
    this.tablesAfter = await this.readTables()
  }

  /** One reading. A read that fails is reported and the run goes on. */
  async sample(): Promise<void> {
    if (this.reading) return
    this.reading = true
    try {
      this.samples.push(await this.read())
    } catch (error) {
      this.options.onError?.(error as Error)
    } finally {
      this.reading = false
    }
  }

  statements(): Statement[] {
    return statementDeltas(this.statementsBefore, this.statementsAfter)
  }

  sequentialScans(): SequentialScan[] {
    return sequentialScans(this.tablesBefore, this.tablesAfter)
  }

  private async read(): Promise<Sample> {
    const { client, poolerAddress } = this.options
    const activity = await client.query<ActivityRow>(
      `${OWN} select application_name, state, host(client_addr) as client_addr, count(*)
       from pg_stat_activity
       where datname = current_database() and backend_type = 'client backend'
         and pid <> pg_backend_pid()
       group by 1, 2, 3`
    )
    const waits = await client.query<{
      waiters: string
      object_waiters: string
      oldest: string | null
    }>(
      `${OWN} select
         count(*) filter (where wait_event_type = 'Lock') as waiters,
         count(*) filter (where wait_event_type = 'Lock' and wait_event = 'object') as object_waiters,
         extract(epoch from max(now() - xact_start)) as oldest
       from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid()`
    )
    return {
      at: Date.now(),
      backends: parseActivity(activity.rows, poolerAddress),
      lockWaiters: Number(waits.rows[0].waiters),
      objectLockWaiters: Number(waits.rows[0].object_waiters),
      oldestTransactionSeconds: Number(waits.rows[0].oldest ?? 0),
      statements: await this.statementTotals()
    }
  }

  private async statementTotals(): Promise<Sample['statements']> {
    if (!this.hasStatements) return null
    const { rows } = await this.options.client.query<{
      calls: string | null
      total: string | null
    }>(
      `${OWN} select sum(calls) as calls, sum(total_exec_time) as total
       from pg_stat_statements
       where dbid = (select oid from pg_database where datname = current_database())
         and query not like '%dbload-sampler%'`
    )
    return {
      calls: Number(rows[0].calls ?? 0),
      totalMs: Number(rows[0].total ?? 0)
    }
  }

  private async readStatements(): Promise<StatementRow[]> {
    if (!this.hasStatements) return []
    const { rows } = await this.options.client.query<StatementRow>(
      `${OWN} select queryid::text, query, calls, total_exec_time, rows
       from pg_stat_statements
       where dbid = (select oid from pg_database where datname = current_database())
         and query not like '%dbload-sampler%'`
    )
    return rows
  }

  private async readTables(): Promise<TableRow[]> {
    const { rows } = await this.options.client.query<TableRow>(
      `${OWN} select relname, seq_scan, n_live_tup from pg_stat_user_tables`
    )
    return rows
  }
}
