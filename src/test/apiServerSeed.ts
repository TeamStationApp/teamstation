import { writeFile } from 'node:fs/promises'

import { sql } from 'kysely'

import { testDatabaseUrl } from '../migrate/testDatabase'
import { apiFixture } from './apiFixture'

/**
 * Leaves a scratch database seeded with `apiFixture` for the real server to
 * run against, and writes what the end-to-end runs need to the JSON file
 * named: the database's address, each person's session token, and the ids
 * of the teams, seasons and games.
 *
 *   node -r sucrase/register src/test/apiServerSeed.ts <out.json>
 *
 * Point `databaseUrl` in the worktree's `serverConfig.json` at it and
 * `npm start`. Drop it with `dropdb` when done.
 */
async function main(): Promise<void> {
  const out = process.argv[2]
  if (out == null) throw new Error('Name the JSON file to write')
  const f = await apiFixture()
  const { rows } = await sql<{
    name: string
  }>`select current_database() as name`.execute(f.h.db)
  const databaseUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${rows[0].name}`)
  await writeFile(
    out,
    `${JSON.stringify(
      {
        databaseUrl,
        tokens: Object.fromEntries(f.h.tokens),
        people: { ...f.people, songkeeper: f.songkeeper },
        players: f.players.map(p => ({
          gumboId: p.id,
          name: `${p.first} ${p.last}`
        })),
        teamA: f.teamA,
        teamB: f.teamB,
        rookies: f.rookies,
        secondTeam: f.secondTeam,
        seasonA: f.seasonA,
        games: f.games.map(g => g.id),
        cometsGame: f.cometsGame
      },
      null,
      2
    )}\n`
  )
  // Close the fixture's own server and pool, and keep the database.
  await new Promise<void>(resolve => {
    f.h.server.close(() => {
      resolve()
    })
  })
  await f.h.db.destroy()
  console.log(`seeded ${databaseUrl}; wrote ${out}`)
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
