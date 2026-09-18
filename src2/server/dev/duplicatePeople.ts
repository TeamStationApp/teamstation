import { findDuplicatePeople } from '../admin/duplicatePeople'
import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'

/**
 * The people who are on a roster twice.
 *
 *   npm run duplicate-people          list them, write nothing
 *   npm run duplicate-people -- --apply
 *
 * Applying closes the row with nothing on it, the way a merged user is
 * closed, rather than deleting it: an id already handed out still resolves,
 * and what was joined to what is not thrown away.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const db = makeDatabase(serverConfig.databaseUrl)

  try {
    const { pairs, ambiguous } = await findDuplicatePeople(db)
    for (const pair of pairs) {
      console.log(
        `${pair.action.padEnd(5)} ${pair.otherName} (${pair.otherPlays} plays)` +
          ` -> ${pair.keepName} (${pair.keepPlays} plays)`
      )
    }
    for (const note of ambiguous) {
      console.log(`?     ${note}: more than one match, left alone`)
    }
    console.log(
      `\n${pairs.filter(p => p.action === 'drop').length} to drop, ` +
        `${pairs.filter(p => p.action === 'merge').length} to merge, ` +
        `${ambiguous.length} unclear`
    )
    if (!apply) {
      console.log('Nothing written. Run again with --apply.')
      return
    }

    for (const pair of pairs) {
      // Whichever of the two has nothing on it is the one that closes. When
      // both have plays this still points the emptier at the fuller name,
      // which is the row a person would recognise.
      const closing =
        pair.otherPlays <= pair.keepPlays ? pair.otherUserId : pair.keepUserId
      const keeping =
        closing === pair.otherUserId ? pair.keepUserId : pair.otherUserId
      await db
        .updateTable('users')
        .set({ merged_into: keeping })
        .where('id', '=', closing)
        .execute()
      await db
        .deleteFrom('memberships')
        .where('user_id', '=', closing)
        .where('team_id', '=', pair.teamId)
        .execute()
    }
    console.log(`closed ${pairs.length}`)
  } finally {
    await db.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
