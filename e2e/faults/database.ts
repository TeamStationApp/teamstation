import pg from 'pg'

/**
 * The stack's own database, reached by the fault server for two control
 * routes, so a scenario never opens the database itself and never goes
 * through the API a fault may be breaking:
 *
 *   POST /__e2e/sql          { text, values? }  { rows, rowCount }
 *   POST /__e2e/rate-limits  { clear?: [scope…], scale? }  { cleared, scale? }
 *
 * `rate-limits` deletes the sign-in limits' rows of each scope (a scope or
 * its family, as `rateLimit.ts` names them), and with `scale` sets
 * `test.rateLimitScale`, which a stack's test settings read afresh on every
 * check, so every limit is that share of production's (1 restores them). Only a pool stack, which holds nothing but
 * fixture worlds, runs either, behind the stack's token.
 */
export interface StackDatabase {
  query: (
    text: string,
    values: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>
  close: () => Promise<void>
}

/** A pool on `databaseUrl`, opened on the first query. */
export function stackDatabase(
  databaseUrl: string,
  makePool: (url: string) => Pick<pg.Pool, 'query' | 'end'> = url =>
    new pg.Pool({ connectionString: url, max: 2 })
): StackDatabase {
  let pool: Pick<pg.Pool, 'query' | 'end'> | undefined
  return {
    query: async (text, values) => {
      pool ??= makePool(databaseUrl)
      const result = await pool.query(text, values)
      return { rows: result.rows, rowCount: result.rowCount ?? 0 }
    },
    close: async () => {
      await pool?.end()
      pool = undefined
    }
  }
}

const SCOPE = /^[A-Za-z][A-Za-z0-9._-]*$/

/** Why a `sql` body cannot run, or undefined when it can. */
export function sqlProblem(body: unknown): string | undefined {
  const { text, values } = (body ?? {}) as { text?: unknown; values?: unknown }
  if (typeof text !== 'string' || text.trim() === '') {
    return 'text is the statement to run'
  }
  if (values != null && !Array.isArray(values)) {
    return 'values are the statement’s parameters, in order'
  }
  return undefined
}

/** What a `rate-limits` body asks: the scopes to clear and the scale to set, or a problem with it. */
export function rateLimitsAsk(
  body: unknown
): { clear: string[]; scale?: number } | string {
  const { scale } = (body ?? {}) as { scale?: unknown }
  if (
    scale != null &&
    (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)
  ) {
    return 'scale is a positive number'
  }
  const clear = scopesToClear(body)
  if (typeof clear === 'string') return clear
  return { clear, ...(scale == null ? {} : { scale }) }
}

/** The scopes a `rate-limits` body clears, or a problem with it. */
export function scopesToClear(body: unknown): string[] | string {
  const clear = (body ?? {}) as { clear?: unknown }
  if (clear.clear == null) return []
  if (
    !Array.isArray(clear.clear) ||
    clear.clear.some(scope => typeof scope !== 'string' || !SCOPE.test(scope))
  ) {
    return 'clear is a list of rate-limit scopes'
  }
  return clear.clear as string[]
}

/** Deletes every rate event of the scopes, each a scope (`password.address`) or its family (`password`). */
export async function clearRateLimits(
  db: StackDatabase,
  scopes: string[]
): Promise<number> {
  let cleared = 0
  for (const scope of scopes) {
    const result = await db.query(
      'DELETE FROM rate_events WHERE scope = $1 OR left(scope, $2) = $3',
      [scope, scope.length + 1, `${scope}.`]
    )
    cleared += result.rowCount
  }
  return cleared
}

/** Sets the share of production's limits a stack's test settings apply. */
export async function setRateLimitScale(
  db: StackDatabase,
  scale: number
): Promise<void> {
  await db.query(
    `INSERT INTO system_settings (key, value) VALUES ('test.rateLimitScale', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(scale)]
  )
}
