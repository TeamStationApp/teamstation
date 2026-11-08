import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import { addEmail } from '../../server/auth/emails'
import { hashPassword } from '../../server/auth/passwords'
import { type Database, makeDatabase } from '../../server/db/database'
import { createScoringGame, userMinter } from '../../server/dev/scoringGame'
import { serverConfig } from '../../server/serverConfig'
import { insertUser } from '../../server/users/insertUser'

/** One person a fixture made. The password is on the manifest and nowhere else. */
interface FixtureAccount {
  role: string
  email: string
  password: string
  userId: string
  displayName: string
}

interface FixtureManifest {
  world: string
  nonce: string
  accounts: Record<string, FixtureAccount>
  /** Every other id the world made, by name. */
  ids: Record<string, string>
}

interface WorldContext {
  db: Kysely<Database>
  nonce: string
}

function makeNonce(): string {
  return randomBytes(4).toString('hex')
}

/** Invented people, with MLB players' names, as `AGENTS.md` asks of test data. */
interface Person {
  first: string
  last: string
}

/** A person who can sign in with a generated password and has finished onboarding. */
async function createAccount(
  context: WorldContext,
  world: string,
  role: string,
  person: Person,
  options: { isAdmin?: boolean } = {}
): Promise<FixtureAccount> {
  const { db, nonce } = context
  const password = randomBytes(18).toString('base64url')
  const email = `${role}-${nonce}@example.test`
  const displayName = `${person.first} ${person.last}`
  const userId = await insertUser(db, {
    display_name: displayName,
    first_name: person.first,
    last_name: person.last,
    password_hash: await hashPassword(password),
    login_enabled: true,
    is_admin: options.isAdmin === true,
    onboarding_step: 'complete',
    onboarding_completed_at: new Date()
  })
  await addEmail(db, userId, email, { isPrimary: true, source: 'manual' })
  return { role, email, password, userId, displayName }
}
/** Three independent writers and a fresh, fully staffed game. */
async function runConcurrentScoring(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'concurrent-scoring'
  const accounts = {
    'scorer-a': await createAccount(context, world, 'scorer-a', {
      first: 'Aaron',
      last: 'Judge'
    }),
    'scorer-b': await createAccount(context, world, 'scorer-b', {
      first: 'Shohei',
      last: 'Ohtani'
    }),
    coach: await createAccount(context, world, 'coach', {
      first: 'Dave',
      last: 'Roberts'
    })
  }
  const game = await context.db.transaction().execute(async trx => {
    const fixture = await createScoringGame(trx, await userMinter(trx), {
      teams: {
        away: `Meteors ${context.nonce}`,
        home: `Comets ${context.nonce}`
      },
      names: {
        away: [
          'Mike Trout',
          'Mookie Betts',
          'Freddie Freeman',
          'Bryce Harper',
          'Juan Soto',
          'Ronald Acuna',
          'Jose Ramirez',
          'Bobby Witt',
          'Corey Seager',
          'Gunnar Henderson',
          'Francisco Lindor',
          'Trea Turner'
        ],
        home: [
          'Paul Skenes',
          'Cal Raleigh',
          'Vladimir Guerrero',
          'Marcus Semien',
          'Gerrit Cole',
          'Manny Machado',
          'Kyle Tucker',
          'Julio Rodriguez',
          'Corbin Carroll',
          'Pete Alonso',
          'Rafael Devers',
          'Matt Olson'
        ]
      }
    })
    for (const [role, account] of Object.entries(accounts)) {
      for (const team of [fixture.awayTeamId, fixture.homeTeamId]) {
        await trx
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            user_id: account.userId,
            team_id: team,
            role: 'member'
          })
          .execute()
        await trx
          .insertInto('scope_roles')
          .values({
            id: makeId('scopeRole'),
            user_id: account.userId,
            scope_type: 'team',
            scope_id: team,
            role: role === 'coach' ? 'coach' : 'scorekeeper'
          })
          .execute()
      }
    }
    return fixture
  })
  return {
    world,
    nonce: context.nonce,
    accounts,
    ids: {
      game: game.games[0],
      home: game.homeTeamId,
      away: game.awayTeamId,
      ...Object.fromEntries(
        Object.entries(game.roster).flatMap(([side, ids]) =>
          ids.map((id, i) => [`${side}-${i + 1}`, id])
        )
      )
    }
  }
}

async function main(): Promise<void> {
  const expected = process.env.TS_CONCURRENT_DATABASE_NAME
  assert(
    expected != null && /^teamstation_/i.test(expected),
    'An explicit development database name is required'
  )
  assert.equal(new URL(serverConfig.databaseUrl).pathname, '/' + expected)
  const output = process.env.TS_CONCURRENT_FIXTURE
  assert(output != null, 'TS_CONCURRENT_FIXTURE output file is required')
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const fixture = await runConcurrentScoring({ db, nonce: makeNonce() })
    await writeFile(output, JSON.stringify(fixture), {
      mode: 0o600,
      flag: 'wx'
    })
    console.log(
      'Created a fresh concurrent-scoring game and private fixture file'
    )
  } finally {
    await db.destroy()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
