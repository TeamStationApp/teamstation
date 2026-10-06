import { findSamePersonAcrossTeams } from '../admin/duplicatePeople'
import {
  closeInto,
  strandedNote,
  strandedRows,
  tidyClosedRows
} from '../admin/people'
import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'

/**
 * One child who has become several people, one per team.
 *
 *   npm run same-person            list them, write nothing
 *   npm run same-person -- --apply
 *
 * Applying closes every row but the fullest into it, which is what a merge is
 * here: nothing moves, `users.merged_into` points at whoever the row became,
 * and every read that wants a whole person asks `onePerson` for the set.
 *
 * The evidence is a first and last name that match exactly, and that is not
 * proof: two children can share both. Read the list before applying it — the
 * teams are printed beside each row for exactly that reason.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const db = makeDatabase(serverConfig.databaseUrl)

  try {
    const groups = await findSamePersonAcrossTeams(db)
    for (const group of groups) {
      const where = group.members
        .map(member => {
          const teams = member.teams.join(', ')
          return `${teams === '' ? 'no team' : teams} (${member.plays} plays)`
        })
        .join(' + ')
      console.log(`${group.name}: ${group.members.length} rows — ${where}`)
    }
    console.log(`\n${groups.length} people are on more than one row`)
    if (!apply) {
      const note = strandedNote(await strandedRows(db))
      if (note != null) console.log(note)
      console.log('Nothing written. Run again with --apply.')
      return
    }

    let closed = 0
    for (const group of groups) {
      for (const member of group.members) {
        if (member.userId === group.keepUserId) continue
        const merge = await closeInto(db, member.userId, group.keepUserId)
        if (merge.closed) closed += 1
      }
    }
    // And anything an earlier run left behind, which is how a roster loses a
    // child: the row was closed and its membership was not moved with it.
    const tidied = await tidyClosedRows(db)
    console.log(
      `closed ${closed} rows into ${groups.length} people` +
        (tidied.moved > 0
          ? `, and moved ${tidied.moved} stranded memberships`
          : '')
    )
    const note = strandedNote(tidied.stranded)
    if (note != null) console.log(note)
  } finally {
    await db.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
