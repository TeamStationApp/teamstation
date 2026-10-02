import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { bothPlayedTogether } from '../events/playedTogether'
import {
  closeInto,
  isFullerName,
  onePerson,
  splitByClash,
  tidyClosedRows
} from './people'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_people_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const legacyOf = new Map<number, string>()
function mintUser(): number {
  const made = mintUserId(id => legacyOf.has(id))
  legacyOf.set(made.userId, made.legacyId)
  return made.userId
}
function legacyId(userId: number): string {
  const id = legacyOf.get(userId)
  if (id == null) throw new Error(`no legacy id for ${userId}`)
  return id
}

describe('one person, however many rows', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  const survivor = mintUser()
  const closed = mintUser()
  const closedTwice = mintUser()
  const stranger = mintUser()

  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    await db
      .insertInto('users')
      .values([
        {
          id: survivor,
          legacyId: legacyId(survivor),
          display_name: 'Jordan Pujols'
        },
        // Closed into the survivor, and one closed into that one: a child can
        // be merged twice as more teams turn up.
        {
          id: closed,
          legacyId: legacyId(closed),
          display_name: 'Jordan Pujols',
          merged_into: survivor
        },
        {
          id: closedTwice,
          legacyId: legacyId(closedTwice),
          display_name: 'Jordan Pujols',
          merged_into: closed
        },
        {
          id: stranger,
          legacyId: legacyId(stranger),
          display_name: 'Somebody Else'
        }
      ])
      .execute()
  })

  after(async function () {
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('gathers every row from the open one', async function () {
    if (db == null) this.skip()
    const person = await onePerson(db, survivor)
    expect(person.userId).equals(survivor)
    expect([...person.userIds].sort((a, b) => a - b)).deep.equals(
      [survivor, closed, closedTwice].sort((a, b) => a - b)
    )
  })

  it('answers the same from a closed one, whichever end it is asked from', async function () {
    if (db == null) this.skip()
    // A link sent last year names a row that has since been closed. It has to
    // land on the whole person, not on a fifth of them.
    for (const id of [closed, closedTwice]) {
      const person = await onePerson(db, id)
      expect(person.userId).equals(survivor)
      expect(person.userIds.length).equals(3)
    }
  })

  it('leaves somebody else alone', async function () {
    if (db == null) this.skip()
    const person = await onePerson(db, stranger)
    expect(person.userIds).deep.equals([stranger])
  })

  it('takes the closed row’s team with it', async function () {
    if (db == null) this.skip()
    const hawks = makeId('team')
    const ravens = makeId('team')
    const mover = mintUser()
    await db
      .insertInto('teams')
      .values([
        { id: hawks, name: 'Hawks' },
        { id: ravens, name: 'Ravens' }
      ])
      .execute()
    await db
      .insertInto('users')
      .values({
        id: mover,
        legacyId: legacyId(mover),
        display_name: 'Miles Mikolas'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values([
        { id: makeId('membership'), team_id: hawks, user_id: survivor },
        { id: makeId('membership'), team_id: ravens, user_id: mover }
      ])
      .execute()

    await closeInto(db, mover, survivor)

    // The child still plays for the Ravens, and a roster asks for people who
    // are still open — so the membership has to move or the team loses them.
    const teams = await db
      .selectFrom('memberships')
      .select(['team_id'])
      .where('user_id', '=', survivor)
      .execute()
    expect(teams.map(row => row.team_id).sort()).deep.equals(
      [hawks, ravens].sort()
    )
  })

  it('keeps the jersey the other row had', async function () {
    if (db == null) this.skip()
    const team = makeId('team')
    const keeper = mintUser()
    const other = mintUser()
    await db
      .insertInto('teams')
      .values({ id: team, name: 'Hawks II' })
      .execute()
    await db
      .insertInto('users')
      .values([
        {
          id: keeper,
          legacyId: legacyId(keeper),
          display_name: 'Casey Mize'
        },
        { id: other, legacyId: legacyId(other), display_name: 'Casey Mize' }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values([
        // The row somebody imported without a number, and the one with it.
        { id: makeId('membership'), team_id: team, user_id: keeper },
        {
          id: makeId('membership'),
          team_id: team,
          user_id: other,
          jersey: '12',
          is_player: true
        }
      ])
      .execute()

    await closeInto(db, other, keeper)

    const rows = await db
      .selectFrom('memberships')
      .select(['user_id', 'jersey', 'is_player'])
      .where('team_id', '=', team)
      .execute()
    expect(rows.length).equals(1)
    expect(rows[0].user_id).equals(keeper)
    expect(rows[0].jersey).equals('12')
    expect(rows[0].is_player).equals(true)
  })

  it('drops a second row on a team the survivor is already on', async function () {
    if (db == null) this.skip()
    const team = await db
      .selectFrom('memberships')
      .select(['team_id'])
      .where('user_id', '=', survivor)
      .executeTakeFirstOrThrow()
    const twin = mintUser()
    await db
      .insertInto('users')
      .values({
        id: twin,
        legacyId: legacyId(twin),
        display_name: 'Miles Mikolas'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: team.team_id,
        user_id: twin
      })
      .execute()

    await closeInto(db, twin, survivor)

    const rows = await db
      .selectFrom('memberships')
      .select(['id'])
      .where('team_id', '=', team.team_id)
      .execute()
    expect(rows.length).equals(1)
  })

  it('knows two rows that both took a turn in one game', async function () {
    if (db == null) this.skip()
    const team = makeId('team')
    const game = makeId('game')
    const one = mintUser()
    const other = mintUser()
    const benched = mintUser()
    await db.insertInto('teams').values({ id: team, name: 'Widows' }).execute()
    await db
      .insertInto('users')
      .values([
        { id: one, legacyId: legacyId(one), display_name: 'Rowan' },
        { id: other, legacyId: legacyId(other), display_name: 'Rowan Wick' },
        { id: benched, legacyId: legacyId(benched), display_name: 'Rowan W' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values({
        id: game,
        home_team_id: team,
        away_team_id: team,
        start_at: new Date('2026-02-21T18:00:00Z')
      })
      .execute()
    await db
      .insertInto('game_player_stats')
      .values([
        { id: makeId('gamePlayerStats'), game_id: game, user_id: one, pa: 1 },
        { id: makeId('gamePlayerStats'), game_id: game, user_id: other, pa: 3 },
        // Entered in the lineup and never up: that is one child written twice,
        // not two children, so it is not evidence against a merge.
        {
          id: makeId('gamePlayerStats'),
          game_id: game,
          user_id: benched,
          pa: 0
        }
      ])
      .execute()

    const together = await bothPlayedTogether(db, [one, other, benched])
    expect(together.has(`${one}|${other}`)).equals(true)
    expect(together.has(`${other}|${one}`)).equals(true)
    expect(together.has(`${one}|${benched}`)).equals(false)
  })

  it('keeps the name with a surname on it', function () {
    const bare = { last_name: null }
    // The row a scorer used all season is usually the bare one, and it is
    // usually the one with the history, so the survivor has to take the name
    // rather than the other way round.
    expect(isFullerName({ last_name: 'Kelly' }, bare)).equals(true)
    expect(isFullerName(bare, { last_name: 'Kelly' })).equals(false)
    // And a note somebody left in the field is not a surname.
    expect(isFullerName({ last_name: '(pool Player)' }, bare)).equals(false)
    expect(
      isFullerName({ last_name: 'José Reyes' }, { last_name: 'J' })
    ).equals(true)
  })

  it('splits a group at the pair that clashes, and no further', function () {
    // `Casey`, and three rows of `Casey Mize`. Only one of the Mizes ever
    // played a game beside Casey; taking the whole group apart made one boy
    // into three.
    const people = splitByClash(
      [
        { userId: 'casey', weight: 219 },
        { userId: 'mizeAllStars', weight: 84 },
        { userId: 'mizeTitan', weight: 24 },
        { userId: 'mizeStars', weight: 4 }
      ],
      new Set(['casey|mizeStars', 'mizeStars|casey'])
    )
    expect(people.length).equals(2)
    expect(people[0]).deep.equals(['casey', 'mizeAllStars', 'mizeTitan'])
    expect(people[1]).deep.equals(['mizeStars'])
  })

  it('leaves a group that clashes nowhere as one person', function () {
    const people = splitByClash(
      [
        { userId: 'a', weight: 5 },
        { userId: 'b', weight: 1 }
      ],
      new Set()
    )
    expect(people).deep.equals([['a', 'b']])
  })

  it('moves what an earlier merge left behind', async function () {
    if (db == null) this.skip()
    const team = makeId('team')
    const stranded = mintUser()
    await db.insertInto('teams').values({ id: team, name: 'Badgers' }).execute()
    // Closed the way the first merge did it: the row was closed and its
    // membership was not moved with it.
    await db
      .insertInto('users')
      .values({
        id: stranded,
        legacyId: legacyId(stranded),
        display_name: 'Jordan Pujols',
        merged_into: survivor
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({ id: makeId('membership'), team_id: team, user_id: stranded })
      .execute()

    expect(await tidyClosedRows(db)).greaterThan(0)

    const moved = await db
      .selectFrom('memberships')
      .select(['user_id'])
      .where('team_id', '=', team)
      .executeTakeFirstOrThrow()
    expect(moved.user_id).equals(survivor)
  })
})
