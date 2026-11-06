import { randomUUID } from 'node:crypto'

import type { Kysely } from 'kysely'

import { atomic } from '../db/atomic'
import { type Database, makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'

/**
 * Gives the database a new roster cache epoch, so no roster cached in Valkey
 * before is read again.
 *
 *   npm run roster-cache-epoch
 *
 * Run it on a database restored from a backup or a point-in-time copy before
 * it serves (migration 109). Valkey is not restored with it, and the restored
 * `team_roster_version_seq` hands out versions already used under the epoch
 * it kept, each of which would find an entry built from rows the restored
 * database does not hold. It prints the old epoch and the new one, neither of
 * which is a secret.
 */
export async function renewRosterCacheEpoch(
  db: Kysely<Database>
): Promise<{ previous: string | null; epoch: string }> {
  const epoch = randomUUID()
  return await atomic(db, async trx => {
    const held = await trx
      .selectFrom('roster_cache_epoch')
      .select('epoch')
      .forUpdate()
      .executeTakeFirst()
    if (held == null)
      await trx.insertInto('roster_cache_epoch').values({ epoch }).execute()
    else await trx.updateTable('roster_cache_epoch').set({ epoch }).execute()
    return { previous: held?.epoch ?? null, epoch }
  })
}

export async function main(
  databaseUrl = serverConfig.databaseUrl
): Promise<void> {
  const db = makeDatabase(databaseUrl)
  try {
    const { previous, epoch } = await renewRosterCacheEpoch(db)
    console.log(`roster cache epoch: ${previous ?? '(none)'} -> ${epoch}`)
  } finally {
    await db.destroy()
  }
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
