import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type Database, makeDatabase } from '../db/database'
import { guardiansOf } from '../people/guardians'
import { closeInto } from './people'

/**
 * U2: a merge keeps the person able to sign in and keeps what they follow.
 * Their links stay on the rows they were made for, and still count for the
 * person those rows now are.
 *
 * The usual case: a roster import made a row for a parent (no address), and
 * the parent's own account is closed into it.
 */
const adminUrl = testDatabaseUrl
const name = `teamstation_close_into_${Date.now()}_${process.pid}`
const url = adminUrl.replace(/\/[^/]*$/, `/${name}`)

const taken = new Set<number>()
function mint(): { id: number; legacyId: string } {
  const made = mintUserId(id => taken.has(id))
  taken.add(made.userId)
  return { id: made.userId, legacyId: made.legacyId }
}

describe('closeInto keeps sign-ins and follows, and leaves links where they are', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  const imported = mint()
  const account = mint()
  const child = mint()
  const sibling = mint()
  const otherParent = mint()
  const both = mint()
  const bothClosed = mint()
  const teamA = makeId('team')
  const teamB = makeId('team')
  let siblingLinkOfAccount = ''

  const database = (): Kysely<Database> => {
    if (db == null) throw new Error('no database')
    return db
  }

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${name}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(url)

    await db
      .insertInto('users')
      .values(
        [
          [imported, 'Pat Parent'],
          [account, 'Pat Parent', 'hash-of-account'],
          [child, 'Kid'],
          [sibling, 'Sib'],
          [otherParent, 'Other'],
          [both, 'Both', 'hash-kept'],
          [bothClosed, 'Both', 'hash-closed']
        ].map(([user, displayName, hash]) => {
          const row = user as { id: number; legacyId: string }
          return {
            id: row.id,
            legacyId: row.legacyId,
            display_name: displayName as string,
            password_hash: (hash as string | undefined) ?? null
          }
        })
      )
      .execute()
    await db
      .insertInto('user_emails')
      .values([
        {
          id: makeId('userEmail'),
          user_id: account.id,
          email: 'pat@example.com',
          is_primary: true
        },
        {
          id: makeId('userEmail'),
          user_id: account.id,
          email: 'pat.work@example.com'
        },
        {
          id: makeId('userEmail'),
          user_id: both.id,
          email: 'both@example.com',
          is_primary: true
        },
        {
          id: makeId('userEmail'),
          user_id: bothClosed.id,
          email: 'both.old@example.com',
          is_primary: true
        }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: teamA, name: 'A' },
        { id: teamB, name: 'B' }
      ])
      .execute()

    const link = async (
      from: number,
      to: number,
      kind: 'guardian' | 'family' | 'other',
      canManage = kind === 'guardian'
    ): Promise<string> => {
      const id = makeId('userLink')
      await database()
        .insertInto('user_links')
        .values({
          id,
          user_id: from,
          related_user_id: to,
          kind,
          can_manage: canManage
        })
        .execute()
      return id
    }
    // Both rows guard the sibling.
    await link(imported.id, sibling.id, 'guardian')
    siblingLinkOfAccount = await link(account.id, sibling.id, 'guardian')
    // Only the account guards the child, and is linked from another parent.
    await link(account.id, child.id, 'guardian')
    await link(otherParent.id, account.id, 'other', true)
    // The imported row and the account are linked to each other.
    await link(account.id, imported.id, 'family')

    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: account.id,
        team_id: teamA,
        granted_by_link_id: siblingLinkOfAccount
      })
      .execute()
    await db
      .insertInto('team_follows')
      .values([
        { user_id: imported.id, team_id: teamA },
        { user_id: account.id, team_id: teamA },
        { user_id: account.id, team_id: teamB }
      ])
      .execute()
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${name} with (force)`)
      await admin.end()
    }
  })

  it('gives the imported row the account’s addresses and password', async function () {
    const before = await database()
      .selectFrom('users')
      .select(['login_enabled'])
      .where('id', '=', imported.id)
      .executeTakeFirstOrThrow()
    expect(before.login_enabled).equals(false)

    await closeInto(database(), account.id, imported.id)

    const rows = await database()
      .selectFrom('users')
      .select(['id', 'login_enabled', 'password_hash', 'merged_into'])
      .where('id', 'in', [imported.id, account.id])
      .orderBy('id')
      .execute()
    const kept = rows.find(row => row.id === imported.id)
    const closed = rows.find(row => row.id === account.id)
    expect(kept).deep.include({
      login_enabled: true,
      password_hash: 'hash-of-account',
      merged_into: null
    })
    expect(closed).deep.include({
      login_enabled: false,
      password_hash: null,
      merged_into: imported.id
    })
    const emails = await database()
      .selectFrom('user_emails')
      .select(['email', 'is_primary'])
      .where('user_id', '=', imported.id)
      .orderBy('email')
      .execute()
    expect(emails).deep.equals([
      { email: 'pat.work@example.com', is_primary: false },
      { email: 'pat@example.com', is_primary: true }
    ])
  })

  it('leaves every link where it was made, and each still counts for the person', async function () {
    const links = await database()
      .selectFrom('user_links')
      .select(['user_id', 'related_user_id', 'kind'])
      .execute()
    expect(
      links.map(row => ({
        from: row.user_id,
        to: row.related_user_id,
        kind: row.kind
      }))
    ).to.have.deep.members([
      { from: imported.id, to: sibling.id, kind: 'guardian' },
      { from: account.id, to: sibling.id, kind: 'guardian' },
      { from: account.id, to: child.id, kind: 'guardian' },
      { from: otherParent.id, to: account.id, kind: 'other' },
      { from: account.id, to: imported.id, kind: 'family' }
    ])
    expect(links.length).equals(5)
    // The membership still names the link that granted it.
    const membership = await database()
      .selectFrom('memberships')
      .select(['user_id', 'granted_by_link_id'])
      .where('team_id', '=', teamA)
      .executeTakeFirstOrThrow()
    expect(membership).deep.equals({
      user_id: imported.id,
      granted_by_link_id: siblingLinkOfAccount
    })
    // The child's guardian is the row the account was closed into, once.
    expect(
      (await guardiansOf(database(), child.id)).map(row => [
        row.userId,
        row.kind
      ])
    ).deep.equals([[imported.id, 'guardian']])
    expect(
      (await guardiansOf(database(), sibling.id)).map(row => row.userId)
    ).deep.equals([imported.id])
  })

  it('moves the follows without doubling any', async function () {
    const follows = await database()
      .selectFrom('team_follows')
      .select(['user_id', 'team_id'])
      .execute()
    expect(follows).to.have.deep.members([
      { user_id: imported.id, team_id: teamA },
      { user_id: imported.id, team_id: teamB }
    ])
    expect(follows.length).equals(2)
  })

  it('keeps the survivor’s own primary address and password', async function () {
    await closeInto(database(), bothClosed.id, both.id)
    const kept = await database()
      .selectFrom('users')
      .select(['password_hash', 'login_enabled'])
      .where('id', '=', both.id)
      .executeTakeFirstOrThrow()
    expect(kept).deep.equals({
      password_hash: 'hash-kept',
      login_enabled: true
    })
    const emails = await database()
      .selectFrom('user_emails')
      .select(['email', 'is_primary'])
      .where('user_id', '=', both.id)
      .orderBy('email')
      .execute()
    expect(emails).deep.equals([
      { email: 'both.old@example.com', is_primary: false },
      { email: 'both@example.com', is_primary: true }
    ])
    // Closing a row into itself is no merge at all.
    expect(await closeInto(database(), sibling.id, sibling.id)).deep.equals({
      closed: false,
      moved: 0
    })
  })
})
