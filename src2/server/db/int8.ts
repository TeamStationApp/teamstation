import { types } from 'pg'

/** Postgres oid for `int8`. `pg` returns it as a string unless a parser is set. */
const INT8 = 20

/**
 * Reads a bigint as a JavaScript number when it is a safe integer, and throws
 * otherwise. User ids are inside that range; a wider value must not be
 * silently rounded.
 *
 * The parser is `pg`'s own, for the whole process, so every `int8` read
 * changes: a user id, but also `count(*)`, `sum()` and any other `bigint`.
 * `makeDatabase` attaches it, and so must anything that builds its own pool.
 */
export function attachInt8Parser(): void {
  types.setTypeParser(INT8, (value: string) => {
    const n = Number(value)
    if (!Number.isSafeInteger(n)) {
      throw new Error(`int8 is not a safe integer: ${value}`)
    }
    return n
  })
}
