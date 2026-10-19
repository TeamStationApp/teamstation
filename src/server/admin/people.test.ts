import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mayEditName } from '../access'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { bothPlayedTogether } from '../events/playedTogether'
import {
  closeInto,
  isFullerName,
  onePerson,
  splitByClash,
  strandedNote,
  strandedRows,
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
        { id: makeId('gamePlayerStats'), game_id: game, gumbo_id: one, pa: 1 },
        {
          id: makeId('gamePlayerStats'),
          game_id: game,
          gumbo_id: other,
          pa: 3
        },
        // Entered in the lineup and never up: that is one child written twice,
        // not two children, so it is not evidence against a merge.
        {
          id: makeId('gamePlayerStats'),
          game_id: game,
          gumbo_id: benched,
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
    const [casey, mizeAllStars, mizeTitan, mizeStars] = [1, 2, 3, 4]
    const people = splitByClash(
      [
        { userId: casey, weight: 219 },
        { userId: mizeAllStars, weight: 84 },
        { userId: mizeTitan, weight: 24 },
        { userId: mizeStars, weight: 4 }
      ],
      new Set([`${casey}|${mizeStars}`, `${mizeStars}|${casey}`])
    )
    expect(people.length).equals(2)
    expect(people[0]).deep.equals([casey, mizeAllStars, mizeTitan])
    expect(people[1]).deep.equals([mizeStars])
  })

  it('leaves a group that clashes nowhere as one person', function () {
    const people = splitByClash(
      [
        { userId: 1, weight: 5 },
        { userId: 2, weight: 1 }
      ],
      new Set()
    )
    expect(people).deep.equals([[1, 2]])
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

    expect((await tidyClosedRows(db)).moved).greaterThan(0)

    const moved = await db
      .selectFrom('memberships')
      .select(['user_id'])
      .where('team_id', '=', team)
      .executeTakeFirstOrThrow()
    expect(moved.user_id).equals(survivor)
  })

  describe('a merge never closes a loop', function () {
    async function row(
      displayName: string,
      name: { first?: string; last?: string } = {}
    ): Promise<number> {
      if (db == null) throw new Error('no database')
      const id = mintUser()
      await db
        .insertInto('users')
        .values({
          id,
          legacyId: legacyId(id),
          display_name: displayName,
          first_name: name.first ?? null,
          last_name: name.last ?? null
        })
        .execute()
      return id
    }

    async function onTeam(userId: number): Promise<string> {
      if (db == null) throw new Error('no database')
      const team = makeId('team')
      await db
        .insertInto('teams')
        .values({ id: team, name: 'Comets' })
        .execute()
      await db
        .insertInto('memberships')
        .values({ id: makeId('membership'), team_id: team, user_id: userId })
        .execute()
      return team
    }

    /** Closed by hand, the way data from before this guard can be. */
    async function closeByHand(
      closing: number,
      keeping: number
    ): Promise<void> {
      if (db == null) throw new Error('no database')
      await db
        .updateTable('users')
        .set({ merged_into: keeping })
        .where('id', '=', closing)
        .execute()
    }

    async function users(ids: number[]): Promise<unknown[]> {
      if (db == null) throw new Error('no database')
      return await db
        .selectFrom('users')
        .select([
          'id',
          'merged_into',
          'first_name',
          'last_name',
          'display_name'
        ])
        .where('id', 'in', ids)
        .orderBy('id')
        .execute()
    }

    async function holder(team: string): Promise<number> {
      if (db == null) throw new Error('no database')
      const found = await db
        .selectFrom('memberships')
        .select(['user_id'])
        .where('team_id', '=', team)
        .executeTakeFirstOrThrow()
      return found.user_id
    }

    it('writes nothing when the kept row is already closed into the closing one', async function () {
      if (db == null) this.skip()
      const bare = await row('Bryce', { first: 'Bryce' })
      const full = await row('Bryce Harper', { first: 'Bryce', last: 'Harper' })
      const team = await onTeam(full)
      await closeInto(db, bare, full)
      const before = await users([bare, full])

      // The other way round would make each row the other's, and copy
      // `Harper` onto the bare row on its way.
      expect(await closeInto(db, full, bare)).deep.equals({
        closed: false,
        moved: 0
      })
      expect(await users([bare, full])).deep.equals(before)
      expect(await holder(team)).equals(full)
    })

    it('follows the whole chain, however long', async function () {
      if (db == null) this.skip()
      // Longer than any walk that stops counting would follow.
      const chain: number[] = []
      for (let i = 0; i < 20; i += 1) chain.push(await row(`Kyle ${i}`))
      for (let i = 0; i < chain.length - 1; i += 1) {
        await closeInto(db, chain[i], chain[i + 1])
      }
      const first = chain[0]
      const last = chain[chain.length - 1]
      const before = await users(chain)

      expect(await closeInto(db, last, first)).deep.equals({
        closed: false,
        moved: 0
      })
      expect(await users(chain)).deep.equals(before)
    })

    it('still closes a row into somebody unrelated', async function () {
      if (db == null) this.skip()
      const bare = await row('Trea')
      const full = await row('Trea Turner')
      const other = await row('Kyle Schwarber')
      const team = await onTeam(full)
      await closeInto(db, bare, full)

      expect(await closeInto(db, full, other)).deep.equals({
        closed: true,
        moved: 1
      })
      const [moved] = (await users([full])) as Array<{ merged_into: number }>
      expect(moved.merged_into).equals(other)
      expect(await holder(team)).equals(other)
    })

    it('passes by a loop already in the data', async function () {
      if (db == null) this.skip()
      const one = await row('Alec')
      const other = await row('Alec Bohm')
      const team = await onTeam(one)
      await closeByHand(one, other)
      await closeByHand(other, one)
      const before = await users([one, other])

      const tidied = await tidyClosedRows(db)
      expect(await users([one, other])).deep.equals(before)
      expect(await holder(team)).equals(one)
      // Left where it is, and said so: the child is on no roster.
      expect(tidied.stranded).to.include(one)
      expect(strandedNote(tidied.stranded)).to.include(String(one))
    })

    it('lets one of two merges at once win, whichever way round', async function () {
      if (db == null) this.skip()
      // Two runs choosing opposite survivors at the same moment: without the
      // lock both passed the check, and nineteen times in twenty the pair
      // ended up closed into each other.
      for (let trial = 0; trial < 10; trial += 1) {
        const one = await row('J.T.')
        const other = await row('J.T. Realmuto')
        await Promise.all([
          closeInto(db, one, other),
          closeInto(db, other, one)
        ])
        const rows = (await users([one, other])) as Array<{
          id: number
          merged_into: number | null
        }>
        const open = rows.filter(found => found.merged_into == null)
        expect(open.length, `trial ${trial}`).equals(1)
        const closed = rows.find(found => found.merged_into != null)
        expect(closed?.merged_into).equals(open[0].id)
      }
    })

    it('merges inside a transaction it is given, and goes when it does', async function () {
      if (db == null) this.skip()
      const kept = await row('Nick Castellanos')
      const undone = await row('Nick')
      const done = await row('Nick C')
      await db
        .transaction()
        .execute(async trx => {
          await closeInto(trx, undone, kept)
          throw new Error('rolled back')
        })
        .catch(() => undefined)
      await db
        .transaction()
        .execute(async trx => await closeInto(trx, done, kept))

      const rows = (await users([undone, done])) as Array<{
        id: number
        merged_into: number | null
      }>
      expect(rows.find(found => found.id === undone)?.merged_into).equals(null)
      expect(rows.find(found => found.id === done)?.merged_into).equals(kept)
    })

    it('closes a row into a loop it is not part of', async function () {
      if (db == null) this.skip()
      const one = await row('Bryson')
      const other = await row('Bryson Stott')
      const stray = await row('Bryson S')
      await closeByHand(one, other)
      await closeByHand(other, one)
      // Closed into the loop by hand, its team row left behind. Its walk ends
      // on `other`, and the walk up from there goes round the loop without
      // ever reaching it.
      await closeByHand(stray, one)
      const team = await onTeam(stray)

      const tidied = await tidyClosedRows(db)
      const [closed] = (await users([stray])) as Array<{ merged_into: number }>
      expect(closed.merged_into).equals(other)
      expect(await holder(team)).equals(other)
      // Moved, but onto a row that is closed too, so it is reported.
      expect(tidied.stranded).to.include(other)
    })

    it('moves a team row past the end of a walk that stopped counting', async function () {
      if (db == null) this.skip()
      // Eighteen rows, the last open: `onePerson` from the first stops two
      // short of it, on a row that is closed too.
      const chain: number[] = []
      for (let i = 0; i < 18; i += 1) chain.push(await row(`Mason ${i}`))
      for (let i = 0; i < chain.length - 1; i += 1) {
        await closeByHand(chain[i], chain[i + 1])
      }
      const team = await onTeam(chain[0])
      const open = chain[chain.length - 1]

      const tidied = await tidyClosedRows(db)
      expect(await holder(team)).equals(open)
      // Not a loop, and not reported as one.
      for (const id of chain) expect(tidied.stranded).not.to.include(id)
    })

    it('tells a loop from a long chain without writing anything', async function () {
      if (db == null) this.skip()
      const one = await row('Edmundo')
      const other = await row('Edmundo Sosa')
      await closeByHand(one, other)
      await closeByHand(other, one)
      await onTeam(one)
      const chain: number[] = []
      for (let i = 0; i < 18; i += 1) chain.push(await row(`Johan ${i}`))
      for (let i = 0; i < chain.length - 1; i += 1) {
        await closeByHand(chain[i], chain[i + 1])
      }
      const team = await onTeam(chain[0])

      const stranded = await strandedRows(db)
      expect(stranded).to.include(one)
      expect(stranded).not.to.include(chain[0])
      // A dry run reads; the long chain's team row has not moved.
      expect(await holder(team)).equals(chain[0])
    })

    it('refuses a caller’s transaction stricter than read committed', async function () {
      if (db == null) this.skip()
      const kept = await row('Brandon Marsh')
      const closing = await row('Brandon')
      let refused: unknown
      await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async trx => await closeInto(trx, closing, kept))
        .catch((error: unknown) => {
          refused = error
        })
      expect(String(refused)).to.include('read committed')
      const [still] = (await users([closing])) as Array<{
        merged_into: number | null
      }>
      expect(still.merged_into).equals(null)
    })

    it('says nothing when no row is left stranded, and counts the rest', function () {
      expect(strandedNote([])).equals(undefined)
      expect(strandedNote([7])).equals(
        '1 closed row still holds team rows, in a merge loop that leaves no ' +
          'row open: 7. That person is on no roster until the loop is ' +
          'opened by hand.'
      )
      expect(strandedNote([7, 9])).to.match(
        /^2 closed rows still hold .*: 7, 9\. Those people are/
      )
    })
  })
})

describe('a guardian across merges', function () {
  this.timeout(60000)

  const scratch = `${scratchName}_guardians`
  const url = adminUrl.replace(/\/[^/]*$/, `/${scratch}`)
  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  const about = { isAdmin: false }

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
    await admin.query(`create database ${scratch}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  })

  after(async function () {
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratch}`)
      await admin.end()
    }
  })

  function database(): Kysely<Database> {
    if (db == null) throw new Error('no database')
    return db
  }

  async function person(name: string): Promise<number> {
    const id = mintUser()
    await database()
      .insertInto('users')
      .values({ id, legacyId: legacyId(id), display_name: name })
      .execute()
    return id
  }

  async function link(
    from: number,
    to: number,
    kind: 'guardian' | 'family' | 'other' = 'guardian'
  ): Promise<void> {
    await database()
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: from,
        related_user_id: to,
        kind
      })
      .execute()
  }

  /**
   * What `repair-people` does to a group it takes apart: every row opened,
   * then each part closed into its first row.
   */
  async function split(group: number[], parts: number[][]): Promise<void> {
    await database()
      .updateTable('users')
      .set({ merged_into: null })
      .where('id', 'in', group)
      .execute()
    for (const [keep, ...rest] of parts) {
      for (const id of rest) await closeInto(database(), id, keep)
    }
  }

  const may = async (actor: number, player: number): Promise<boolean> =>
    await mayEditName(database(), actor, player, about)

  const links = async (): Promise<unknown[]> =>
    await database()
      .selectFrom('user_links')
      .selectAll()
      .orderBy('id')
      .execute()

  it('gives a parent the child’s name on the row their child was merged into', async function () {
    if (db == null) this.skip()
    const parent = await person('Yadier Molina')
    const placeholder = await person('Unknown player')
    const child = await person('Nolan Arenado')
    await link(parent, placeholder)
    const written = await links()

    expect(await may(parent, child)).equals(false)
    await closeInto(db, placeholder, child)
    expect(await may(parent, child)).equals(true)
    expect(await may(parent, placeholder)).equals(true)
    // Nothing is written to make that so.
    expect(await links()).deep.equals(written)
  })

  it('keeps a parent’s children when their own rows are merged', async function () {
    if (db == null) this.skip()
    const child = await person('Adley Rutschman')
    const imported = await person('Cedric Mullins')
    const signsIn = await person('Cedric Mullins')
    await link(imported, child)

    expect(await may(signsIn, child)).equals(false)
    await closeInto(db, imported, signsIn)
    expect(await may(signsIn, child)).equals(true)
  })

  it('counts a family link and not an other one, merged or not', async function () {
    if (db == null) this.skip()
    const aunt = await person('Ketel Marte')
    const neighbour = await person('Corbin Carroll')
    const placeholder = await person('Gabriel')
    const child = await person('Gabriel Moreno')
    await link(aunt, placeholder, 'family')
    await link(neighbour, placeholder, 'other')

    expect(await may(aunt, placeholder)).equals(true)
    expect(await may(neighbour, placeholder)).equals(false)
    await closeInto(db, placeholder, child)
    expect(await may(aunt, child)).equals(true)
    expect(await may(neighbour, child)).equals(false)
  })

  it('gives nobody a child they have no link to', async function () {
    if (db == null) this.skip()
    const parent = await person('Salvador Perez')
    const otherParent = await person('Bobby Witt')
    const placeholder = await person('Vinnie')
    const child = await person('Vinnie Pasquantino')
    const stranger = await person('Maikel Garcia')
    await link(parent, placeholder)
    await link(otherParent, stranger)

    await closeInto(db, placeholder, child)
    expect(await may(otherParent, child)).equals(false)
    expect(await may(parent, stranger)).equals(false)
  })

  it('takes the name back when the merge is undone, after the parent’s rows merged too', async function () {
    if (db == null) this.skip()
    const parent = await person('Jose Ramirez')
    const parentAgain = await person('Jose Ramirez')
    const child = await person('Steven Kwan')
    const kept = await person('Steven Kwan')
    await link(parent, child)
    await closeInto(db, child, kept)
    await closeInto(db, parent, parentAgain)
    expect(await may(parentAgain, kept)).equals(true)
    const written = await links()

    // They batted in one game: two boys, so the group is taken apart.
    await split([kept, child], [[kept], [child]])
    expect(await may(parentAgain, kept)).equals(false)
    expect(await may(parentAgain, child)).equals(true)
    expect(await links()).deep.equals(written)
  })

  it('keeps what is still one person when a group is split in part', async function () {
    if (db == null) this.skip()
    const parent = await person('Bryan Reynolds')
    const parentAgain = await person('Bryan Reynolds')
    const otherParent = await person('Oneil Cruz')
    const kept = await person('Jared Jones')
    const sameChild = await person('Jared')
    const otherChild = await person('Jared J')
    await link(parent, sameChild)
    await link(otherParent, otherChild)
    await closeInto(db, sameChild, kept)
    await closeInto(db, otherChild, kept)
    await closeInto(db, parent, parentAgain)
    expect(await may(otherParent, kept)).equals(true)

    await split(
      [kept, sameChild, otherChild],
      [[kept, sameChild], [otherChild]]
    )
    expect(await may(parentAgain, kept)).equals(true)
    expect(await may(otherParent, kept)).equals(false)
    expect(await may(otherParent, otherChild)).equals(true)
  })

  it('keeps a link made to the kept row itself, whatever else is undone', async function () {
    if (db == null) this.skip()
    const parent = await person('Pete Alonso')
    const parentAgain = await person('Pete Alonso')
    const parentThird = await person('Pete Alonso')
    const kept = await person('Francisco Alvarez')
    const placeholder = await person('Francisco')
    await link(parent, placeholder)
    await link(parentThird, kept)
    await closeInto(db, placeholder, kept)
    await closeInto(db, parent, parentAgain)
    await closeInto(db, parentThird, parentAgain)

    await split([kept, placeholder], [[kept], [placeholder]])
    expect(await may(parentAgain, kept)).equals(true)
    expect(await may(parentAgain, placeholder)).equals(true)
  })

  it('knows a player asking about their own name from another of their rows', async function () {
    if (db == null) this.skip()
    const old = await person('Julio')
    const kept = await person('Julio Rodriguez')
    const stranger = await person('Cal Raleigh')
    await closeInto(db, old, kept)
    expect(await may(old, kept)).equals(true)
    expect(await may(kept, old)).equals(true)
    expect(await may(stranger, kept)).equals(false)

    // Two rows closed into each other: each walk stops on the other row, so
    // neither names the same row as open, and they are still one person.
    const one = await person('Jarred')
    const other = await person('Jarred Kelenic')
    // Written by hand: `closeInto` will not make a loop, but data from before
    // it refused one can hold it.
    for (const [closing, keeping] of [
      [one, other],
      [other, one]
    ]) {
      await database()
        .updateTable('users')
        .set({ merged_into: keeping })
        .where('id', '=', closing)
        .execute()
    }
    expect(await may(one, other)).equals(true)
    expect(await may(other, one)).equals(true)
    expect(await may(stranger, other)).equals(false)
  })

  it('uses the rows a caller already gathered, and only when they are the player’s', async function () {
    if (db == null) this.skip()
    const parent = await person('Freddie Freeman')
    const placeholder = await person('Will')
    const child = await person('Will Smith')
    const stranger = await person('Mookie Betts')
    const cousin = await person('Gavin Lux')
    await link(parent, placeholder)
    await link(parent, cousin)
    await closeInto(db, placeholder, child)

    // Rows that hold the player are taken as given, not walked again: a row
    // the parent is linked to answers only because it was handed over.
    expect(await may(parent, stranger)).equals(false)
    expect(
      await mayEditName(db, parent, stranger, about, {
        player: { userId: stranger, userIds: [stranger, cousin] }
      })
    ).equals(true)

    const gathered = await onePerson(db, child)
    expect(
      await mayEditName(db, parent, child, about, { player: gathered })
    ).equals(true)
    // The child's rows handed over for somebody else are ignored, and the
    // question is answered about the one actually asked.
    expect(
      await mayEditName(db, parent, stranger, about, { player: gathered })
    ).equals(false)
    expect(
      await mayEditName(db, parent, child, about, {
        player: { userId: stranger, userIds: [stranger] }
      })
    ).equals(true)
  })

  it('gives the name to a coach whose player’s team row is still on a closed row', async function () {
    if (db == null) this.skip()
    const team = makeId('team')
    const otherTeam = makeId('team')
    await db
      .insertInto('teams')
      .values([
        { id: team, name: 'Owls' },
        { id: otherTeam, name: 'Larks' }
      ])
      .execute()
    const coach = await person('Ozzie Albies')
    const otherCoach = await person('Austin Riley')
    const old = await person('Michael')
    const kept = await person('Michael Harris')
    for (const [userId, teamId, role] of [
      [coach, team, 'coach'],
      [otherCoach, otherTeam, 'coach']
    ] as const) {
      await db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: userId,
          scope_type: 'team',
          scope_id: teamId,
          role
        })
        .execute()
    }
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: team,
        user_id: old,
        is_player: true
      })
      .execute()
    // Closed by hand, the way merges were made before `closeInto` moved the
    // team rows: the membership is still under the closed row.
    await db
      .updateTable('users')
      .set({ merged_into: kept })
      .where('id', '=', old)
      .execute()

    expect(await may(coach, kept)).equals(true)
    expect(await may(otherCoach, kept)).equals(false)
  })
})
