/** Rows a multi-row statement takes at once, well inside its parameters. */
export const ROWS_PER_STATEMENT = 500

/** `rows` in runs of `ROWS_PER_STATEMENT`, one statement's worth each. */
export function runsOf<T>(rows: readonly T[]): T[][] {
  const runs: T[][] = []
  for (let at = 0; at < rows.length; at += ROWS_PER_STATEMENT)
    runs.push(rows.slice(at, at + ROWS_PER_STATEMENT))
  return runs
}
