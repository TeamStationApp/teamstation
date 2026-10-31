import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import {
  seedFixture,
  taggedIn,
  type TokensFile
} from '../../tools/dbLoad/fixture'
import {
  captureGolden,
  GHOST_ID,
  type Golden,
  type Labels,
  labelsOf,
  namedActor,
  namedScopes,
  readGolden,
  seedAgreementShapes,
  setHierarchyReady,
  writeGolden
} from '../../tools/dbLoad/scopeGolden'
import { TEST_AMOUNTS } from '../../tools/dbLoad/testAmounts'
import { openScratch, type Scratch } from '../../tools/dbLoad/testSupport'
import { visibleScopes, visibleScopesForUsers } from './access'
import { onePeople, type OnePerson, onePerson } from './admin/people'
import { actorForToken, actorsForTokens, createSession } from './auth/sessions'
import { hashToken } from './auth/tokens'
import type { Database } from './db/database'
import { checkScopeAgreement } from './dev/scopeAgreementCheck'

const RUN = 'golden'

/** The walk `onePeople` replaced, one statement a step, kept as its measure. */
async function walked(
  db: Kysely<Database>,
  userId: string
): Promise<OnePerson> {
  const MAX_DEPTH = 16
  let survivor = userId
  const seen = new Set<string>([userId])
  for (let step = 0; step < MAX_DEPTH; step += 1) {
    const row = await db
      .selectFrom('users')
      .select(['merged_into'])
      .where('id', '=', survivor)
      .executeTakeFirst()
    const next = row?.merged_into
    if (next == null || seen.has(next)) break
    seen.add(next)
    survivor = next
  }
  const userIds = new Set<string>([survivor])
  let frontier = [survivor]
  for (let step = 0; step < MAX_DEPTH && frontier.length > 0; step += 1) {
    const rows = await db
      .selectFrom('users')
      .select(['id'])
      .where('merged_into', 'in', frontier)
      .execute()
    frontier = rows.map(row => row.id).filter(id => !userIds.has(id))
    for (const id of frontier) userIds.add(id)
  }
  return { userId: survivor, userIds: [...userIds] }
}

const sortedPerson = (person: OnePerson | undefined): unknown =>
  person == null
    ? person
    : { userId: person.userId, userIds: [...person.userIds].sort() }

/** Reorders `ids` the same way each run, so that batches mix kinds of person. */
function shuffled(ids: string[]): string[] {
  let seed = 0x5eed
  const out = [...ids]
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 48271) + 11) & 0x7fffffff
    const j = seed % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * The batched reads against the single-user ones, and the single-user ones
 * against what they answered before they were built on the batched reads, for
 * every kind of person and every shape of the load fixture.
 */
describe('who may see what, batched and one at a time', function () {
  this.timeout(600_000)

  let scratch: Scratch
  let tokens: TokensFile
  let credentials: Map<string, string>
  let labels: Labels
  let everybody: string[]

  /** Every credential the fixture and the shapes made, by its golden label. */
  const allCredentials = (): Array<[string, string]> => [
    ...tokens.accounts.map(
      account => [`account:${account.label}`, account.token] as [string, string]
    ),
    ...credentials
  ]

  function firstDifferences(actual: Golden, expected: Golden): string[] {
    const differences: string[] = []
    for (const section of ['people', 'actors'] as const) {
      const names = new Set([
        ...Object.keys(actual[section]),
        ...Object.keys(expected[section])
      ])
      for (const name of names) {
        const a = JSON.stringify(actual[section][name])
        const e = JSON.stringify(expected[section][name])
        if (a !== e)
          differences.push(`${section} ${name}\n  got  ${a}\n  want ${e}`)
      }
    }
    return differences
  }

  before(async function () {
    scratch = await openScratch('agreement')
    tokens = await seedFixture(scratch.db, {
      runId: RUN,
      scale: 'small',
      overrides: TEST_AMOUNTS,
      log: () => undefined
    })
    credentials = await seedAgreementShapes(scratch.db, RUN)
    labels = await labelsOf(scratch.db, RUN)
    everybody = (
      await scratch.db.selectFrom('users').select('id').orderBy('id').execute()
    ).map(row => row.id)
    everybody.push(GHOST_ID)
  })

  after(async function () {
    await setHierarchyReady(scratch.db, false)
    await scratch.drop()
  })

  describe('the fixture they are measured on', function () {
    it('holds every kind of person and shape, and every row is labelled', async function () {
      const users = await taggedIn(scratch.db, RUN, 'user')
      for (const label of [
        'person.admin',
        'person.coach',
        'person.scorekeeper',
        'person.guardian',
        'person.teamMember',
        'person.seasonMember',
        'person.leagueMember',
        'person.seasonRole',
        'person.leagueRole',
        'person.merged',
        'person.disabled',
        'person.revokedSession',
        'person.expiredSession',
        'person.apiToken',
        'person.userKey',
        'worst.mergedMany',
        'worst.chain.row00000',
        'worst.guardian',
        'worst.manyRoles',
        'worst.largeMember',
        'worst.manySessions',
        'shape.keptScopes',
        'shape.keptGuardian',
        'shape.selfGuardian',
        'shape.chain17.row0',
        'shape.loopA',
        'shape.ghost'
      ])
        expect(users.has(label), label).equals(true)
      const labelled = new Set(users.values())
      expect(everybody.filter(id => !labelled.has(id))).deep.equals([])
    })
  })

  for (const mode of ['legacy', 'ready'] as const)
    describe(`with the season links ${mode === 'ready' ? 'of a ready hierarchy' : 'as they stand before one'}`, function () {
      before(async function () {
        await setHierarchyReady(scratch.db, mode === 'ready')
      })

      it('answers one at a time as it did before the batched reads', async function () {
        const actual = await captureGolden(scratch.db, RUN, tokens, credentials)
        const golden = readGolden()
        if (process.env.SCOPE_GOLDEN_WRITE === mode)
          writeGolden({ ...golden, [mode]: actual })
        const differences = firstDifferences(actual, golden[mode])
        expect(
          differences.slice(0, 20),
          differences.length + ' differ'
        ).deep.equals([])
        expect(Object.keys(actual.people).length).above(400)
        expect(Object.keys(actual.actors).length).above(50)
      })

      it('answers everybody at once as it answers each alone', async function () {
        const single = new Map<string, unknown>()
        for (const id of everybody)
          single.set(
            id,
            namedScopes(labels, await visibleScopes(scratch.db, id, false))
          )
        for (const ids of [
          everybody,
          [...everybody].reverse(),
          [...everybody, ...everybody.slice(0, 10)]
        ]) {
          const batched = await visibleScopesForUsers(scratch.db, ids)
          expect(batched.size).equals(everybody.length)
          for (const id of everybody)
            expect(namedScopes(labels, batched.get(id)!), id).deep.equals(
              single.get(id)
            )
        }
      })

      it('answers the same in any company', async function () {
        const single = new Map<string, unknown>()
        for (const id of everybody)
          single.set(
            id,
            namedScopes(labels, await visibleScopes(scratch.db, id, false))
          )
        const mixed = shuffled(everybody)
        for (const size of [2, 3, 7, 31]) {
          for (let at = 0; at < mixed.length; at += size) {
            const ids = mixed.slice(at, at + size)
            const batched = await visibleScopesForUsers(scratch.db, ids)
            for (const id of ids)
              expect(namedScopes(labels, batched.get(id)!), id).deep.equals(
                single.get(id)
              )
          }
        }
      })

      it('finds no disagreement over the whole database', async function () {
        const lines: string[] = []
        const result = await checkScopeAgreement(scratch.db, {
          batchSize: 50,
          print: line => {
            lines.push(line)
          }
        })
        expect(result.disagreements).deep.equals([])
        expect(result.people).equals(everybody.length - 1)
        expect(lines).deep.equals([
          `${result.people} people in ${result.batches} batches of up to 50: 0 disagreements`
        ])
      })
    })

  describe('onePeople', function () {
    it('agrees with the walk for every row in the database', async function () {
      const people = await onePeople(scratch.db, everybody)
      expect(people.size).equals(everybody.length)
      for (const id of everybody) {
        expect(sortedPerson(people.get(id)), id).deep.equals(
          sortedPerson(await walked(scratch.db, id))
        )
        expect(sortedPerson(await onePerson(scratch.db, id)), id).deep.equals(
          sortedPerson(people.get(id))
        )
      }
    })

    const userOf = (label: string): string => labels.users.get(label)!

    it('walks up and down to the limit at each depth', async function () {
      for (const depth of [15, 16]) {
        const top = userOf(`shape.chain${depth}.row${depth}`)
        const bottom = userOf(`shape.chain${depth}.row0`)
        expect((await onePerson(scratch.db, bottom)).userId).equals(top)
        expect((await onePerson(scratch.db, top)).userIds).to.have.length(
          depth + 1
        )
      }
      // Seventeen steps up stops one short of the open row, and seventeen
      // down stops one short of the far end, as the walk did.
      const bottom = await onePerson(scratch.db, userOf('shape.chain17.row0'))
      expect(bottom.userId).equals(userOf('shape.chain17.row16'))
      expect(bottom.userIds).to.have.length(17)
      const top = await onePerson(scratch.db, userOf('shape.chain17.row17'))
      expect(top.userId).equals(userOf('shape.chain17.row17'))
      expect(top.userIds).to.have.length(17)
      expect(top.userIds).not.to.include(userOf('shape.chain17.row0'))
    })

    it('answers depths of none and one, and a wide merge', async function () {
      const alone = await onePerson(scratch.db, userOf('person.stranger'))
      expect(alone.userIds).deep.equals([userOf('person.stranger')])
      const closed = await onePerson(scratch.db, userOf('person.merged'))
      expect(closed.userId).equals(userOf('person.mergedKept'))
      expect(closed.userIds).to.have.length(2)
      expect(closed.userIds[0]).equals(userOf('person.mergedKept'))
      const wide = await onePerson(scratch.db, userOf('worst.mergedMany'))
      expect(wide.userIds).to.have.length(25)
    })

    it('stops at a loop, and answers for a row nobody has', async function () {
      const loop = await onePerson(scratch.db, userOf('shape.loopA'))
      expect(loop.userId).equals(userOf('shape.loopC'))
      expect([...loop.userIds].sort()).deep.equals(
        [
          userOf('shape.loopA'),
          userOf('shape.loopB'),
          userOf('shape.loopC'),
          userOf('shape.loopTail')
        ].sort()
      )
      expect(await onePerson(scratch.db, GHOST_ID)).deep.equals({
        userId: GHOST_ID,
        userIds: [GHOST_ID]
      })
    })

    it('reads nothing for nobody, and one statement however deep', async function () {
      const statements: string[] = []
      const counting = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: scratch.url, max: 1 })
        }),
        log: event => {
          statements.push(event.query.sql)
        }
      })
      try {
        expect((await onePeople(counting, [])).size).equals(0)
        expect(statements).deep.equals([])
        await onePeople(counting, [userOf('shape.chain17.row0')])
        expect(statements).to.have.length(1)
        await onePeople(counting, everybody)
        expect(statements).to.have.length(2)
      } finally {
        await counting.destroy()
      }
    })
  })

  describe('actorsForTokens', function () {
    it('answers every credential as actorForToken does, all at once', async function () {
      const all = allCredentials()
      const batched = await actorsForTokens(
        scratch.db,
        all.map(([, token]) => token)
      )
      const golden = readGolden().legacy.actors
      let refused = 0
      for (const [label, token] of all) {
        const single = await actorForToken(scratch.db, token, {
          recordUse: false
        })
        expect(batched.get(token), label).deep.equals(single)
        expect(namedActor(labels, batched.get(token)), label).deep.equals(
          golden[label]
        )
        if (single == null) refused += 1
      }
      expect(refused).above(10)
      expect(refused).below(all.length)
    })

    it('answers the same in any company, and for a token asked twice', async function () {
      const all = shuffled(allCredentials().map(([, token]) => token))
      for (let at = 0; at < all.length; at += 3) {
        const some = all.slice(at, at + 3)
        const batched = await actorsForTokens(scratch.db, [...some, ...some])
        for (const token of some)
          expect(batched.get(token)).deep.equals(
            await actorForToken(scratch.db, token, { recordUse: false })
          )
      }
    })

    it('reads nothing for no tokens, and one read per kind of credential', async function () {
      const statements: string[] = []
      const counting = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: scratch.url, max: 1 })
        }),
        log: event => {
          statements.push(event.query.sql)
        }
      })
      try {
        expect((await actorsForTokens(counting, [])).size).equals(0)
        expect(statements).deep.equals([])
        await actorsForTokens(
          counting,
          allCredentials().map(([, token]) => token)
        )
        expect(statements).to.have.length(3)
        statements.length = 0
        await actorsForTokens(counting, [credentials.get('session.good')!])
        expect(statements).to.have.length(1)
      } finally {
        await counting.destroy()
      }
    })

    it('writes last use on each credential, unless told not to', async function () {
      const holder = labels.users.get('shape.holder')!
      const session = await createSession(scratch.db, holder, 'use')
      const lastUse = async (): Promise<unknown> =>
        (
          await scratch.db
            .selectFrom('auth_sessions')
            .select('last_used_at')
            .where('token_hash', '=', hashToken(session.token))
            .executeTakeFirstOrThrow()
        ).last_used_at
      await actorForToken(scratch.db, session.token, { recordUse: false })
      expect(await lastUse()).equals(null)
      await actorForToken(scratch.db, session.token)
      expect(await lastUse()).not.equals(null)
      for (const label of ['token.good', 'key.good']) {
        const token = credentials.get(label)!
        const table = label === 'key.good' ? 'user_api_keys' : 'api_tokens'
        const row = async (): Promise<unknown> =>
          (
            await scratch.db
              .selectFrom(table)
              .select('last_used_at')
              .where('token_hash', '=', hashToken(token))
              .executeTakeFirstOrThrow()
          ).last_used_at
        await actorForToken(scratch.db, token, { recordUse: false })
        expect(await row()).equals(null)
        await actorForToken(scratch.db, token)
        expect(await row()).not.equals(null)
      }
    })
  })

  describe('scopeAgreementCheck', function () {
    it('names only the id of somebody the reads disagree about', async function () {
      const lines: string[] = []
      const wrong = labels.users.get('person.coach')!
      const result = await checkScopeAgreement(scratch.db, {
        batchSize: 1000,
        print: line => {
          lines.push(line)
        },
        batchedScopes: async (db, ids) => {
          const scopes = await visibleScopesForUsers(db, ids)
          scopes.get(wrong)?.teamIds.add('tea_extra')
          scopes.delete(labels.users.get('person.admin')!)
          return scopes
        }
      })
      expect(result.disagreements.sort()).deep.equals(
        [wrong, labels.users.get('person.admin')!].sort()
      )
      expect(
        lines.filter(line => line.startsWith('disagreement'))
      ).to.have.length(2)
      expect(lines.at(-1)).contains('2 disagreements')
    })
  })
})
