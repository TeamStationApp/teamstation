import { type RawBuilder, sql } from 'kysely'

/**
 * The right-hand side of `column = any($1)`: one parameter however many values
 * there are, so a read of many has the same statement text as a read of one.
 */
export function anyOf(values: readonly string[]): RawBuilder<string> {
  return sql<string>`any(${[...values]}::text[])`
}
