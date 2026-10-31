import { Pool } from 'pg'

import { serverConfig } from '../server/serverConfig'
import { migrations } from './migrations'
import { migrateDown, migrateUp, migrationPoolConfig } from './runner'

async function main(): Promise<void> {
  const [command = 'up', countText] = process.argv.slice(2)
  const pool = new Pool(migrationPoolConfig(serverConfig.databaseUrl))
  // What a migration reports of its backfill (`raise notice`).
  pool.on('connect', client => {
    client.on('notice', notice => {
      console.log(`notice: ${notice.message}`)
    })
  })

  try {
    if (command === 'up') {
      const { applied, alreadyApplied } = await migrateUp(pool, migrations)
      console.log(`already applied: ${alreadyApplied.length}`)
      if (applied.length === 0) console.log('nothing to do')
      for (const name of applied) console.log(`applied ${name}`)
    } else if (command === 'down') {
      const count = countText == null ? 1 : Number(countText)
      const rolledBack = await migrateDown(pool, migrations, count)
      for (const name of rolledBack) console.log(`rolled back ${name}`)
    } else {
      throw new Error(`Unknown command ${command}. Use "up" or "down [count]".`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
