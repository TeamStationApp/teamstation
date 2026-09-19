import {
  bothPlayedTogether,
  isFullerName,
  keepTheFullerName,
  onePerson,
  tidyClosedRows
} from '../admin/people'
import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'

/**
 * Undoes merges that should never have been made, and repairs what they cost.
 *
 *   npm run repair-people            say what is wrong, write nothing
 *   npm run repair-people -- --apply
 *
 * Two things, in order:
 *
 * 1. **Two children who are one person.** Every row of every merged person is
 *    checked against every other for a game they were both in. `Casey Mize`
 *    and `Casey` both played on 11 April and are now one 23-game career,
 *    which got through because the merge was a chain and the test only ever
 *    looked at two rows at a time. The whole group is opened back up rather
 *    than guessing which link was the wrong one.
 * 2. **A surname that closed.** The row with the most history is the one that
 *    survives, and the row a scorer used all season is usually the bare first
 *    name — so `Carson Kelly` became `Carson` on eight children at once. The
 *    survivor takes the fullest name its group holds.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const db = makeDatabase(serverConfig.databaseUrl)

  try {
    // --- 1. merges that the evidence refuses ------------------------------
    const closed = await db
      .selectFrom('users')
      .select(['id', 'merged_into'])
      .where('merged_into', 'is not', null)
      .execute()

    const people = new Map<string, string[]>()
    for (const row of closed) {
      const person = await onePerson(db, row.id)
      people.set(person.userId, person.userIds)
    }

    const together = await bothPlayedTogether(db, [
      ...new Set([...people.values()].flat())
    ])

    let opened = 0
    for (const [survivor, ids] of people) {
      const clash = ids.some(a => ids.some(b => together.has(`${a}|${b}`)))
      if (!clash) continue
      const names = await db
        .selectFrom('users')
        .select(['id', 'display_name'])
        .where('id', 'in', ids)
        .execute()
      console.log(
        `open  ${names.map(row => row.display_name).join(' + ')} — ` +
          'two of these were in one game together'
      )
      opened += ids.length - 1
      if (!apply) continue
      await db
        .updateTable('users')
        .set({ merged_into: null, updated_at: new Date() })
        .where('id', 'in', ids)
        .where('id', '<>', survivor)
        .execute()
    }

    // --- 2. the name the survivor should be under -------------------------
    let renamed = 0
    for (const [survivor, ids] of people) {
      for (const id of ids) {
        if (id === survivor) continue
        if (!apply) {
          const rows = await db
            .selectFrom('users')
            .select(['id', 'last_name', 'display_name'])
            .where('id', 'in', [id, survivor])
            .execute()
          const from = rows.find(row => row.id === id)
          const to = rows.find(row => row.id === survivor)
          if (from != null && to != null && isFullerName(from, to)) {
            console.log(`name  ${to.display_name} -> ${from.display_name}`)
            renamed += 1
          }
          continue
        }
        if (await keepTheFullerName(db, id, survivor)) renamed += 1
      }
    }

    const moved = apply ? await tidyClosedRows(db) : 0
    console.log(
      `\n${opened} rows opened back up, ${renamed} names restored, ` +
        `${moved} memberships moved`
    )
    if (!apply) console.log('Nothing written. Run again with --apply.')
  } finally {
    await db.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
