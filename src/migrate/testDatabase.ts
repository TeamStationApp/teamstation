/**
 * The cluster every database test makes its scratch databases on:
 * `TS_TEST_DATABASE_URL` when it is set, and otherwise localhost:5433, the
 * local Postgres 18 cluster, never the older server on 5432 beside it.
 * `requirePostgres18.js` runs under plain Node before the tests, so it keeps
 * the one other copy of this rule.
 */
export const testDatabaseUrl =
  process.env.TS_TEST_DATABASE_URL ?? 'postgres://localhost:5433/postgres'
