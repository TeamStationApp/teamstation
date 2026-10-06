import {
  closeInto,
  isFullerName,
  keepTheFullerName,
  onePerson,
  splitByClash,
  strandedNote,
  strandedRows,
  tidyClosedRows
} from '../admin/people'
import { makeDatabase } from '../db/database'
import { bothPlayedTogether } from '../events/playedTogether'
import { serverConfig } from '../serverConfig'

/**
 * Undoes merges that should never have been made, and repairs what they cost.
 *
 *   npm run repair-people            say what is wrong, write nothing
 *   npm run repair-people -- --apply
 *
 * Three things, in order:
 *
 * 1. **Two children who are one person.** Every row of every person, merged or
 *    open, is checked against every other for a game they were both in, and a
 *    group that clashes is **split at the clash** rather than dissolved: one
 *    pair sharing a game does not make every row in the group a stranger. It
 *    also puts back together rows that were separated too eagerly — the rows
 *    that clash with nobody become one person again.
 * 2. **A surname that closed.** The row with the most history is the one that
 *    survives, and the row a scorer used all season is usually the bare first
 *    name — so `Carson Kelly` became `Carson` on eight children at once. The
 *    survivor takes the fullest name its group holds.
 * 3. **Two team rows for one person.** A merge moves memberships onto the
 *    survivor, so a team can end up holding the same person twice. One row
 *    per person per team is kept: the one with a shirt number, then the one
 *    that is a player.
 *
 * Step 3 deletes no team row just because nothing seems to back it. Only a
 * roster can vouch for a parent, a coach, a spectator or a player who has not
 * played yet, and this script has no roster to read, so the rows that neither
 * a roster nor a stat line names are counted (and listed on a dry run), never
 * removed. A stat line exists only for a game the stats engine has counted,
 * so a player whose games it has not reached yet is among them.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const db = makeDatabase(serverConfig.databaseUrl)

  try {
    // --- 1. who is actually one person ------------------------------------
    //
    // Every row that a name could join: the people we already made, and the
    // rows of a group that was taken apart too far. Whoever shares a name and
    // a team is a candidate to be one person again, and the games decide.
    const everybody = await db
      .selectFrom('users')
      .select(['id', 'merged_into', 'first_name', 'last_name', 'display_name'])
      .execute()

    const groups = new Map<number, number[]>()
    for (const row of everybody) {
      const person = await onePerson(db, row.id)
      groups.set(person.userId, person.userIds)
    }

    const together = await bothPlayedTogether(
      db,
      everybody.map(row => row.id)
    )

    const plays = new Map<number, number>()
    for (const row of await db
      .selectFrom('event_players')
      .select(['user_id'])
      .select(eb => eb.fn.countAll<number>().as('plays'))
      .groupBy('user_id')
      .execute()) {
      plays.set(row.user_id, Number(row.plays))
    }

    let opened = 0
    const split = new Set<number>()
    for (const [survivor, ids] of groups) {
      if (ids.length < 2) continue
      const people = splitByClash(
        ids.map(id => ({
          userId: id,
          weight: plays.get(id) ?? 0
        })),
        together
      )
      if (people.length < 2) continue

      const names = await db
        .selectFrom('users')
        .select(['id', 'display_name'])
        .where('id', 'in', ids)
        .execute()
      const shown = (group: number[]): string =>
        group
          .map(
            id => names.find(row => row.id === id)?.display_name ?? String(id)
          )
          .join(' + ')
      console.log(
        `split ${people.map(shown).join('  |  ')} — they were in a game together`
      )
      opened += ids.length - people.length
      split.add(survivor)
      if (!apply) continue

      // Open the group, then close each part into its own fullest row.
      await db
        .updateTable('users')
        .set({ merged_into: null, updated_at: new Date() })
        .where('id', 'in', ids)
        .execute()
      for (const person of people) {
        const [keep, ...rest] = person
        for (const id of rest) {
          await closeInto(db, id, keep)
        }
      }
    }

    // --- 2. the name the survivor should be under -------------------------
    //
    // Not for a group that has just been opened back up: those rows are their
    // own people again, and giving one of them the other's surname is the
    // mistake being undone.
    let renamed = 0
    const people = groups
    for (const [survivor, ids] of people) {
      if (split.has(survivor)) continue
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
        if (await keepTheFullerName(db, id, survivor)) {
          renamed += 1
        }
      }
    }

    // --- 3. one team row per person -------------------------------------
    //
    // A merge moves memberships onto the survivor, so a team can list one boy
    // twice. Those duplicates go.
    //
    // A row with no stat line behind it stays. Without a roster, nothing here
    // can tell a merge's leftover from a parent, a coach or a player who has
    // not played yet, so those rows are only reported.
    const byPerson = new Map<number, number>()
    for (const row of await db.selectFrom('users').select(['id']).execute()) {
      byPerson.set(row.id, (await onePerson(db, row.id)).userId)
    }

    const playedFor = new Set<string>()
    for (const row of await db
      .selectFrom('game_player_stats')
      .select(['user_id', 'team_id'])
      .where('team_id', 'is not', null)
      .execute()) {
      const person = byPerson.get(row.user_id)
      if (person != null) playedFor.add(`${person}|${row.team_id ?? ''}`)
    }

    const memberships = await db
      .selectFrom('memberships')
      .select(['id', 'user_id', 'team_id', 'jersey', 'is_player'])
      .execute()

    // Group what we hold by the person it really belongs to.
    const held = new Map<string, typeof memberships>()
    for (const row of memberships) {
      const person = byPerson.get(row.user_id) ?? row.user_id
      const key = `${person}|${row.team_id}`
      const rows = held.get(key) ?? []
      rows.push(row)
      held.set(key, rows)
    }

    let unvouched = 0
    let deduped = 0
    for (const [key, rows] of held) {
      if (!playedFor.has(key)) {
        unvouched += rows.length
        if (!apply) console.log(`kept ${key}: no plays, and no roster to ask`)
      }
      if (rows.length < 2) continue
      // One row per person per team: keep the one with a number, then the one
      // that is a player.
      const best =
        rows.find(row => (row.jersey ?? '').trim() !== '') ??
        rows.find(row => row.is_player) ??
        rows[0]
      deduped += rows.length - 1
      if (!apply) {
        console.log(`dedupe ${key}: ${rows.length} rows`)
        continue
      }
      await db
        .deleteFrom('memberships')
        .where(
          'id',
          'in',
          rows.filter(row => row.id !== best.id).map(row => row.id)
        )
        .execute()
    }

    // A dry run moves nothing, and still says which rows a tidy could not.
    const tidied = apply
      ? await tidyClosedRows(db)
      : { moved: 0, stranded: await strandedRows(db) }
    console.log(
      `\n${opened} rows split off, ${renamed} names restored, ` +
        `${deduped} duplicates dropped, ${tidied.moved} memberships moved`
    )
    const note = strandedNote(tidied.stranded)
    if (note != null) console.log(note)
    console.log(
      `${unvouched} team rows have no plays behind them and were kept: ` +
        'without a roster to read, pruning them would delete parents, ' +
        'coaches and players who have not played yet'
    )
    if (!apply) console.log('Nothing written. Run again with --apply.')
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('/repairPeople.ts') || entry.endsWith('/repairPeople.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
