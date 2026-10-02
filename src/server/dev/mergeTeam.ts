import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

import { mergeTeams } from '../admin/mergeTeams'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { serverConfig } from '../serverConfig'

/**
 * Finding and joining the rows that are one real team.
 *
 *   npm run merge-team                          what looks like a duplicate
 *   npm run merge-team -- <fromId> <intoId>     what a merge would do
 *   npm run merge-team -- <fromId> <intoId> --apply
 *
 * Nothing is written without `--apply`. The default is a report, because this
 * moves games between teams and deletes a game row, and the first thing anyone
 * should see is what it is about to do.
 */

interface Candidate {
  externalId: string
  externalName: string
  fullId: string
  fullName: string
  /** Fixtures where both played the same opponent at the same minute. */
  collisions: number
  when: string[]
}

/**
 * Two teams that played the same opponent at the same minute are the same
 * team.
 *
 * Not a guess about names. A team cannot be in two places at once, and two
 * genuinely different teams cannot both be playing the same third team at the
 * same moment — so a collision is evidence rather than a resemblance. It is
 * also the thing that actually matters: those are precisely the fixtures whose
 * halves need joining, one holding the plays and the other the video.
 *
 * Coach surnames are deliberately not used. `NP5 Hardy` and `AAA Hawks` share
 * nothing in their names, and `Black Sox (Boren)` and `MC1 Lopez` look no less
 * alike than a pair that really is one team.
 */
async function findCandidates(db: Kysely<Database>): Promise<Candidate[]> {
  const games = await db
    .selectFrom('games')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .select([
      'games.id as id',
      'games.start_at as startAt',
      'games.home_team_id as homeId',
      'games.away_team_id as awayId',
      'home.name as homeName',
      'home.kind as homeKind',
      'away.name as awayName',
      'away.kind as awayKind'
    ])
    .where('home.merged_into', 'is', null)
    .where('away.merged_into', 'is', null)
    .execute()

  // Who played whom, at each minute.
  interface Side {
    teamId: string
    name: string
    kind: string
    opponentId: string
  }
  const byMinute = new Map<string, Side[]>()
  for (const game of games) {
    const minute = new Date(game.startAt).toISOString()
    const list = byMinute.get(minute) ?? []
    list.push({
      teamId: game.homeId,
      name: game.homeName,
      kind: game.homeKind,
      opponentId: game.awayId
    })
    list.push({
      teamId: game.awayId,
      name: game.awayName,
      kind: game.awayKind,
      opponentId: game.homeId
    })
    byMinute.set(minute, list)
  }

  const found = new Map<string, Candidate>()
  for (const [minute, sides] of byMinute) {
    for (const a of sides) {
      for (const b of sides) {
        if (a.teamId >= b.teamId) continue
        if (a.opponentId !== b.opponentId) continue
        // One of the pair should be the external stand-in.
        const external =
          a.kind === 'external' ? a : b.kind === 'external' ? b : null
        const full = external === a ? b : external === b ? a : null
        if (external == null || full == null) continue
        if (full.kind !== 'full') continue

        const key = `${external.teamId}|${full.teamId}`
        const entry = found.get(key) ?? {
          externalId: external.teamId,
          externalName: external.name,
          fullId: full.teamId,
          fullName: full.name,
          collisions: 0,
          when: []
        }
        entry.collisions += 1
        entry.when.push(minute.slice(0, 16).replace('T', ' '))
        found.set(key, entry)
      }
    }
  }

  return [...found.values()].sort((a, b) => b.collisions - a.collisions)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(arg => arg !== '--apply')
  const apply = process.argv.includes('--apply')
  // Its own pool rather than `makeDatabase`, so it attaches the parser that
  // reads user ids as numbers itself.
  attachInt8Parser()
  const pool = new Pool({ connectionString: serverConfig.databaseUrl })
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

  try {
    if (args.length < 2) {
      const candidates = await findCandidates(db)
      if (candidates.length === 0) {
        console.log('No team looks like a duplicate of another.')
        return
      }
      console.log(
        `${candidates.length} pair(s) played the same opponent at the same minute,\nwhich no two different teams can do:\n`
      )
      for (const c of candidates) {
        console.log(`  ${c.externalName}  is  ${c.fullName}`)
        console.log(`    ${c.collisions} fixture(s): ${c.when.join(', ')}`)
        console.log(`    npm run merge-team -- ${c.externalId} ${c.fullId}\n`)
      }
      return
    }

    const [fromTeamId, intoTeamId] = args
    const report = await mergeTeams(db, { fromTeamId, intoTeamId, apply })

    console.log(
      `${report.applied ? 'Merged' : 'Would merge'} ${report.fromTeamName} into ${report.intoTeamName}\n`
    )
    console.log('  rows repointed:')
    for (const [where, n] of Object.entries(report.repointed)) {
      console.log(`    ${where}: ${n}`)
    }
    console.log(`\n  ${report.fixtures.length} fixture(s) held twice:`)
    for (const f of report.fixtures) {
      console.log(`    ${f.startAt.slice(0, 16).replace('T', ' ')}`)
      console.log(
        `      keep    ${f.keptGameId}  ${f.keptEvents} events` +
          (f.orientationDiffers ? '   (the two disagreed on home/away)' : '')
      )
      console.log(
        `      retire  ${f.retiredGameId}  ${f.retiredEvents} events` +
          `, moving ${f.videosMoved} video(s), ${f.externalIdsMoved} id(s)`
      )
    }
    if (report.eventsDiscarded > 0) {
      console.log(
        `\n  ${report.eventsDiscarded} event(s) go with the retired games. Worth a look if that is large.`
      )
    }

    if (!apply) console.log('\nNothing was written. Add --apply to do it.')
  } finally {
    await db.destroy()
  }
}

// Run as a program only, so a test can load it without connecting.
const entry = process.argv[1] ?? ''
if (entry.endsWith('/mergeTeam.ts') || entry.endsWith('/mergeTeam.js')) {
  main().catch((error: unknown) => {
    console.error(String(error))
    process.exit(1)
  })
}
