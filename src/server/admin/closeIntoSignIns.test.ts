import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { findUserByEmail } from '../auth/emails'
import { type Database, makeDatabase } from '../db/database'
import { guardiansOf } from '../people/guardians'
import { mintUserId } from '../users/mintUserId'
import { closeInto } from './people'

/**
 * U2: a merge keeps the person able to sign in and keeps what they follow.
 * Their addresses, password and links stay on the rows they were made for:
 * signing in follows the merge, and each link still counts for the person
 * those rows now are.
 *
 * The usual case: a roster import made a row for a parent (no address), and
 * the parent's own account is closed into it.
 */
const adminUrl = testDatabaseUrl
const name = `teamstation_close_into_${Date.now()}_${process.pid}`
const url = adminUrl.replace(/\/[^/]*$/, `/${name}`)

function mint(): { id: string } {
  return { id: mintUserId() }
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
          const row = user as { id: string }
          return {
            id: row.id,
            display_name: displayName as string,
            password_hash: (hash as string | undefined) ?? null,
            // The accounts; the imported row and the children are not.
            login_enabled: [account, both, bothClosed].includes(row)
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
      from: string,
      to: string,
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

  it('lets the person sign in to the imported row through the account’s own addresses', async function () {
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
    // Switched on, as the account it absorbed was.
    expect(kept).deep.include({
      login_enabled: true,
      password_hash: null,
      merged_into: null
    })
    // The closed row keeps its password and its addresses.
    expect(closed).deep.include({
      password_hash: 'hash-of-account',
      merged_into: imported.id
    })
    const emails = await database()
      .selectFrom('user_emails')
      .select(['user_id', 'email', 'is_primary'])
      .where('email', 'in', ['pat@example.com', 'pat.work@example.com'])
      .orderBy('email')
      .execute()
    expect(emails).deep.equals([
      { user_id: account.id, email: 'pat.work@example.com', is_primary: false },
      { user_id: account.id, email: 'pat@example.com', is_primary: true }
    ])
    // Either address signs in to the imported row, as itself.
    for (const email of ['pat@example.com', 'Pat.Work@example.com'])
      expect(await findUserByEmail(database(), email), email).deep.include({
        id: imported.id,
        loginEnabled: true,
        passwordHash: null
      })
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
      .select(['user_id', 'email', 'is_primary'])
      .where('email', 'in', ['both@example.com', 'both.old@example.com'])
      .orderBy('email')
      .execute()
    expect(emails).deep.equals([
      {
        user_id: bothClosed.id,
        email: 'both.old@example.com',
        is_primary: true
      },
      { user_id: both.id, email: 'both@example.com', is_primary: true }
    ])
    // The closed row's address reaches the survivor, with its password.
    expect(
      await findUserByEmail(database(), 'both.old@example.com')
    ).deep.include({ id: both.id, passwordHash: 'hash-kept' })
    // Closing a row into itself is no merge at all.
    expect(await closeInto(database(), sibling.id, sibling.id)).deep.equals({
      closed: false,
      moved: 0
    })
  })
})
