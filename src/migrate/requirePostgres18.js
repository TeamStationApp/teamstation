// Stops `npm run coverage` before any test runs when the test cluster is too
// old. Migration 031 adds `virtual` generated columns to `events`, which
// Postgres has only from 18 on, so on an older server every database test
// fails in its `before` hook with a syntax error that says nothing about
// versions. It asks the cluster the database tests use: `GS_TEST_DATABASE_URL`
// when it is set, and otherwise localhost:5433, the local Postgres 18 cluster,
// not the older server on 5432 beside it. It runs under plain Node, so it
// keeps its own copy of the rule `testDatabase.ts` gives the tests.

const { Client } = require('pg')

async function main() {
  const client = new Client({
    connectionString:
      process.env.GS_TEST_DATABASE_URL ?? 'postgres://localhost:5433/postgres'
  })
  await client.connect()
  const { rows } = await client.query('show server_version_num')
  await client.end()
  const version = Number(rows[0].server_version_num)
  if (!(version >= 180000)) {
    console.error(`Postgres ${version} is below 180000`)
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
