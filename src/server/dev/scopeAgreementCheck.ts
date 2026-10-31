import type { Kysely } from 'kysely'

import {
  type VisibleScopes,
  visibleScopes,
  visibleScopesForUsers
} from '../access'
import { onePeople, type OnePerson, onePerson } from '../admin/people'
import { type Database, makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'

/**
 * Compares the batched permission reads with the single-user ones for every
 * person in a database, a batch at a time, so a person's answer is seen not to
 * depend on who else was asked about in the same read. Prints only counts and
 * the internal ids of people who disagree.
 *
 *   npm run scope-agreement -- --batch-size 200
 */

export interface AgreementOptions {
  batchSize?: number
  print: (line: string) => void
  /** Stands in for the batched read, so the check itself can be checked. */
  batchedScopes?: typeof visibleScopesForUsers
}

export interface AgreementResult {
  people: number
  batches: number
  disagreements: string[]
}

function sameScopes(a: VisibleScopes | undefined, b: VisibleScopes): boolean {
  if (a == null) return false
  const sorted = (set?: ReadonlySet<string>): string =>
    JSON.stringify([...(set ?? [])].sort())
  return (
    a.isAdmin === b.isAdmin &&
    sorted(a.teamIds) === sorted(b.teamIds) &&
    sorted(a.seasonIds) === sorted(b.seasonIds) &&
    sorted(a.guardedIds) === sorted(b.guardedIds)
  )
}

function samePerson(a: OnePerson | undefined, b: OnePerson): boolean {
  if (a == null) return false
  return (
    a.userId === b.userId &&
    JSON.stringify([...a.userIds].sort()) ===
      JSON.stringify([...b.userIds].sort())
  )
}

export async function checkScopeAgreement(
  db: Kysely<Database>,
  options: AgreementOptions
): Promise<AgreementResult> {
  const batchSize = options.batchSize ?? 200
  const batchedScopes = options.batchedScopes ?? visibleScopesForUsers
  const result: AgreementResult = { people: 0, batches: 0, disagreements: [] }
  let after = ''
  for (;;) {
    const rows = await db
      .selectFrom('users')
      .select('id')
      .where('id', '>', after)
      .orderBy('id')
      .limit(batchSize)
      .execute()
    if (rows.length === 0) break
    after = rows[rows.length - 1].id
    const ids = rows.map(row => row.id)
    const scopes = await batchedScopes(db, ids)
    const people = await onePeople(db, ids)
    for (const id of ids) {
      const agrees =
        sameScopes(scopes.get(id), await visibleScopes(db, id, false)) &&
        samePerson(people.get(id), await onePerson(db, id))
      if (!agrees) {
        result.disagreements.push(id)
        options.print(`disagreement: ${id}`)
      }
    }
    result.people += ids.length
    result.batches += 1
  }
  options.print(
    `${result.people} people in ${result.batches} batches of up to ${batchSize}: ${result.disagreements.length} disagreements`
  )
  return result
}

/* c8 ignore start */
async function main(): Promise<void> {
  const at = process.argv.indexOf('--batch-size')
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const { disagreements } = await checkScopeAgreement(db, {
      batchSize: at < 0 ? undefined : Number(process.argv[at + 1]),
      print: console.log
    })
    if (disagreements.length > 0) process.exitCode = 1
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (
  entry.endsWith('/scopeAgreementCheck.ts') ||
  entry.endsWith('/scopeAgreementCheck.js')
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
/* c8 ignore stop */
