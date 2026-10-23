import { Pool } from 'pg'
import { type Expr, parse, toSql } from 'pgsql-ast-parser'

import { badRequest, unavailable } from '../../common/errors'

const columns = new Set([
  'occurred_at',
  'received_at',
  'event_id',
  'app',
  'event_name',
  'user_id',
  'session_id',
  'schema_revision',
  'properties'
])
const properties = new Set([
  'pg',
  'ms',
  'mt',
  'sp',
  'ec',
  'id',
  'ty',
  'ok',
  'vi',
  'ps',
  'pos',
  'dur',
  'rt',
  'bytes',
  'op',
  'status',
  'n',
  'on'
])
const operators = new Set([
  '=',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  'AND',
  'OR',
  '+',
  '-',
  '*',
  '/',
  '%',
  'IN',
  'NOT IN',
  'LIKE',
  'NOT LIKE'
])
const functions = new Set([
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'date_trunc',
  'date_part',
  'coalesce',
  'nullif'
])
function reject(): never {
  throw badRequest('Unsupported analytics query')
}
function keys(value: object, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) reject()
}
function name(value: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) reject()
}

/** A small positive SQL grammar. Original SQL is never sent to the database. */
export function analyticsSql(
  sql: unknown,
  parameters: unknown = []
): { text: string; values: Array<string | number | boolean | null> } {
  if (
    typeof sql !== 'string' ||
    Buffer.byteLength(sql) > 16384 ||
    !Array.isArray(parameters) ||
    parameters.length > 32
  )
    reject()
  for (const value of parameters) {
    if (
      value !== null &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value)) &&
      !(typeof value === 'string' && value.length <= 256)
    )
      reject()
  }
  const values = parameters
  let statements
  try {
    statements = parse(sql)
  } catch {
    reject()
  }
  if (statements.length !== 1 || statements[0].type !== 'select') reject()
  const statement = statements[0]
  keys(statement, [
    'type',
    'columns',
    'from',
    'where',
    'groupBy',
    'having',
    'orderBy',
    'limit',
    'distinct'
  ])
  if (statement.from?.length !== 1 || statement.from[0].type !== 'table')
    reject()
  const from = statement.from[0]
  keys(from, ['type', 'name'])
  keys(from.name, ['name', 'schema', 'alias'])
  if (from.name.name !== 'events' || from.name.schema !== 'analytics') reject()
  if (from.name.alias != null) name(from.name.alias)
  const aliases = new Set<string>()
  let nodes = 0
  function expression(expr: Expr, depth = 0): void {
    if (++nodes > 300 || depth > 16) reject()
    const visit = (child: Expr): void => {
      expression(child, depth + 1)
    }
    switch (expr.type) {
      case 'ref':
        keys(expr, ['type', 'name', 'table'])
        if (
          !columns.has(expr.name) &&
          !aliases.has(expr.name) &&
          expr.name !== '*'
        )
          reject()
        if (expr.table != null) {
          keys(expr.table, ['name'])
          if (expr.table.name !== (from.name.alias ?? 'events')) reject()
        }
        break
      case 'string':
      case 'integer':
      case 'numeric':
      case 'boolean':
        keys(expr, ['type', 'value'])
        if (typeof expr.value === 'string' && expr.value.length > 256) reject()
        if (typeof expr.value === 'number' && !Number.isFinite(expr.value))
          reject()
        break
      case 'null':
        keys(expr, ['type'])
        break
      case 'parameter':
        keys(expr, ['type', 'name'])
        if (
          !/^\$[1-9][0-9]?$/.test(expr.name) ||
          Number(expr.name.slice(1)) > values.length
        )
          reject()
        break
      case 'binary':
        keys(expr, ['type', 'op', 'left', 'right'])
        if (!operators.has(expr.op)) reject()
        visit(expr.left)
        visit(expr.right)
        break
      case 'unary':
        keys(expr, ['type', 'op', 'operand'])
        if (!['NOT', '+', '-', 'IS NULL', 'IS NOT NULL'].includes(expr.op))
          reject()
        visit(expr.operand)
        break
      case 'list':
        keys(expr, ['type', 'expressions'])
        if (expr.expressions.length > 50) reject()
        expr.expressions.forEach(visit)
        break
      case 'member':
        keys(expr, ['type', 'operand', 'op', 'member'])
        if (
          expr.operand.type !== 'ref' ||
          expr.operand.name !== 'properties' ||
          expr.op !== '->>' ||
          !properties.has(String(expr.member))
        )
          reject()
        visit(expr.operand)
        break
      case 'cast':
        keys(expr, ['type', 'operand', 'to'])
        keys(expr.to, ['name'])
        if (
          expr.to.kind === 'array' ||
          ![
            'numeric',
            'double precision',
            'integer',
            'bigint',
            'text',
            'timestamptz',
            'date'
          ].includes(expr.to.name)
        )
          reject()
        visit(expr.operand)
        break
      case 'call':
        keys(expr, ['type', 'function', 'args', 'distinct'])
        keys(expr.function, ['name'])
        if (
          !functions.has(expr.function.name) ||
          expr.args.length > 4 ||
          (expr.distinct != null && expr.distinct !== 'distinct')
        )
          reject()
        expr.args.forEach(visit)
        break
      default:
        reject()
    }
  }
  if (statement.columns == null || statement.columns.length > 20) reject()
  for (const column of statement.columns) {
    keys(column, ['expr', 'alias'])
    if (column.alias != null) {
      keys(column.alias, ['name'])
      name(column.alias.name)
      aliases.add(column.alias.name)
    }
    expression(column.expr)
  }
  if (statement.where != null) expression(statement.where)
  if (statement.having != null) expression(statement.having)
  statement.groupBy?.forEach(expr => {
    expression(expr)
  })
  for (const order of statement.orderBy ?? []) {
    keys(order, ['by', 'order', 'nulls'])
    if (order.order != null && !['ASC', 'DESC'].includes(order.order)) reject()
    if (order.nulls != null && !['FIRST', 'LAST'].includes(order.nulls))
      reject()
    expression(order.by)
  }
  if (statement.distinct != null && statement.distinct !== 'distinct') reject()
  if (statement.limit != null) {
    keys(statement.limit, ['limit', 'offset'])
    for (const value of [statement.limit.limit, statement.limit.offset])
      if (
        value != null &&
        (value.type !== 'integer' || value.value < 0 || value.value > 10000)
      )
        reject()
  }
  // Wrapping preserves a requested smaller limit while bounding every result.
  return {
    text: `SELECT * FROM (${toSql.statement(statement)}) AS result LIMIT 1001`,
    values: parameters
  }
}

/** No owner fallback; runtime checks fail closed if the configured role is too powerful. */
export class AnalyticsReader {
  private readonly pool: Pool
  private active = 0
  constructor(connectionString: string) {
    if (connectionString === '')
      throw new Error('Analytics reader connection required')
    this.pool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 2000,
      statement_timeout: 2000
    })
    this.pool.on('error', () => {})
    this.pool.on('connect', client => {
      client.on('error', () => {})
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async query(
    sql: unknown,
    parameters?: unknown
  ): Promise<{ rows: unknown[]; truncated: boolean }> {
    const request = analyticsSql(sql, parameters)
    if (this.active >= 2) throw unavailable('Analytics query capacity reached')
    this.active++
    let client
    try {
      client = await this.pool.connect()
      await client.query(
        "BEGIN READ ONLY; SET LOCAL search_path = pg_catalog; SET LOCAL statement_timeout = '2s'; SET LOCAL lock_timeout = '500ms'"
      )
      const { rows } = await client.query(`SELECT
        NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
        AND NOT has_database_privilege(current_database(), 'CREATE')
        AND NOT has_database_privilege(current_database(), 'TEMP')
        AND has_table_privilege('analytics.events', 'SELECT')
        AND NOT has_table_privilege('analytics.events', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
          AND c.relkind IN ('r','p','v','m','f') AND c.oid <> 'analytics.events'::regclass
          AND has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS safe
        FROM pg_roles r WHERE rolname=current_user`)
      if (rows[0]?.safe !== true)
        throw unavailable('Analytics reader permissions invalid')
      const firstSlot = await client.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('analytics-query'),0) AS acquired"
      )
      if (firstSlot.rows[0].acquired !== true) {
        const secondSlot = await client.query(
          "SELECT pg_try_advisory_xact_lock(hashtext('analytics-query'),1) AS acquired"
        )
        if (secondSlot.rows[0].acquired !== true)
          throw unavailable('Analytics query capacity reached')
      }
      const result = await client.query(request.text, request.values)
      const kept: unknown[] = []
      let size = 2
      for (const row of result.rows) {
        const length = Buffer.byteLength(JSON.stringify(row)) + 1
        if (kept.length === 1000 || size + length > 1048000) break
        kept.push(row)
        size += length
      }
      return { rows: kept, truncated: kept.length !== result.rows.length }
    } catch {
      throw unavailable('Analytics query unavailable or exceeded its limits')
    } finally {
      if (client != null) {
        try {
          await client.query('ROLLBACK')
        } catch {
          client.release(true)
          client = undefined
        }
        client?.release()
      }
      this.active--
    }
  }
}
