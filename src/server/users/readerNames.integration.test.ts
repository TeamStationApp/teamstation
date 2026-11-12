import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type { Role } from '../../common/roles'
import { userIdOfGumbo } from '../../common/userId'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { statsDatabase } from '../../test/statsDatabase'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { fullNamesFor, type Reader, readerOf, runSpoken } from './readerNames'

/**
 * Mookie Betts plays for the Hawks (`tem_home`), and the Owls (`tem_away`)
 * hold him only by an open add. The Hawks' staff hold each role there; the
 * Owls' coach holds only that add.
 */
describe('reader names', function () {
  this.timeout(60000)
  const fixture = statsDatabase('readernames')
  const taken = new Set<number>()
  const ids = new Map<string, string>()
  const idOf = (name: string): string => ids.get(name)!
  const reader = (name: string, isAdmin = false): Reader => ({
    userId: idOf(name),
    isAdmin
  })
  const STAFF: ReadonlyArray<readonly [string, Role]> = [
    ['Buster Posey', 'admin'],
    ['Bruce Bochy', 'coach'],
    ['Dave Righetti', 'assistant'],
    ['Hunter Pence', 'scorekeeper'],
    ['Brandon Crawford', 'songkeeper'],
    ['Joe Panik', 'videographer']
  ]
  const PEOPLE = [
    'Mookie Betts',
    'Ken Griffey',
    'Craig Biggio',
    'Dave Roberts',
    'Aaron Judge',
    ...STAFF.map(([name]) => name)
  ]

  before(async function () {
    const db = fixture.db
    for (const name of PEOPLE) {
      const one = mintUserId(id => taken.has(id))
      taken.add(one.userId)
      ids.set(name, userIdOfGumbo(one.userId))
      await insertFixtureUsers(db, {
        id: one.userId,
        legacyId: one.legacyId,
        display_name: name
      })
    }
    const player = idOf('Mookie Betts')
    const owls = makeId('membership')
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: player,
          team_id: 'tem_home',
          is_player: true
        },
        { id: owls, user_id: player, team_id: 'tem_away', is_player: true }
      ])
      .execute()
    await db
      .insertInto('group_requests')
      .values({
        id: 'grq_owls_add',
        kind: 'playerAdd',
        sender_id: idOf('Dave Roberts'),
        sender_scope_type: 'team',
        sender_scope_id: 'tem_away',
        terms: JSON.stringify({
          mode: 'roster',
          userId: player,
          membershipId: owls
        }),
        status: 'applied',
        sent_at: new Date(Date.now() - 86_400_000),
        expires_at: new Date(Date.now() + 86_400_000),
        initiating_team_id: 'tem_away'
      })
      .execute()
    await db
      .insertInto('scope_roles')
      .values([
        ...STAFF.map(([name, role]) => ({
          id: makeId('scopeRole'),
          user_id: idOf(name),
          scope_type: 'team' as const,
          scope_id: 'tem_home',
          role,
          granted_at: new Date()
        })),
        {
          id: makeId('scopeRole'),
          user_id: idOf('Dave Roberts'),
          scope_type: 'team' as const,
          scope_id: 'tem_away',
          role: 'coach' as const,
          granted_at: new Date()
        }
      ])
      .execute()
    await db
      .insertInto('user_links')
      .values([
        {
          id: makeId('userLink'),
          user_id: idOf('Ken Griffey'),
          related_user_id: player,
          kind: 'guardian' as const,
          created_at: new Date()
        },
        {
          id: makeId('userLink'),
          user_id: idOf('Craig Biggio'),
          related_user_id: player,
          kind: 'family' as const,
          created_at: new Date()
        }
      ])
      .execute()
  })

  const reads = async (name: string, isAdmin = false): Promise<boolean> =>
    (
      await fullNamesFor(fixture.db, reader(name, isAdmin), [
        idOf('Mookie Betts')
      ])
    ).has(idOf('Mookie Betts'))

  it('reads in full whom the reader may name: self, guardian, family, roster staff and a site admin', async function () {
    for (const name of [
      'Mookie Betts',
      'Ken Griffey',
      'Craig Biggio',
      'Buster Posey',
      'Bruce Bochy',
      'Dave Righetti',
      'Hunter Pence'
    ])
      expect(await reads(name), name).equals(true)
    const everyone = await fullNamesFor(
      fixture.db,
      reader('Aaron Judge', true),
      PEOPLE.map(idOf)
    )
    expect([...everyone].sort()).deep.equals(PEOPLE.map(idOf).sort())
  })

  it("reads nobody in full for a songkeeper, a videographer, an open add's staff or a stranger", async function () {
    for (const name of [
      'Brandon Crawford',
      'Joe Panik',
      'Dave Roberts',
      'Aaron Judge'
    ])
      expect(await reads(name), name).equals(false)
    // Once the add can no longer be rejected, he is the Owls' player too.
    const expire = async (at: Date): Promise<void> => {
      await fixture.db
        .updateTable('group_requests')
        .set({ expires_at: at })
        .where('id', '=', 'grq_owls_add')
        .execute()
    }
    await expire(new Date(Date.now() - 1000))
    try {
      expect(await reads('Dave Roberts')).equals(true)
    } finally {
      await expire(new Date(Date.now() + 86_400_000))
    }
  })

  it('reads nobody in full with no reader, or for a model', async function () {
    const player = [idOf('Mookie Betts')]
    expect((await fullNamesFor(fixture.db, undefined, player)).size).equals(0)
    expect(
      (await fullNamesFor(fixture.db, reader('Bruce Bochy'), [])).size
    ).equals(0)
    expect(
      (
        await runSpoken(
          async () =>
            await fullNamesFor(fixture.db, reader('Aaron Judge', true), player)
        )
      ).size
    ).equals(0)
  })

  it("reads a level people manager's people in full, never for a machine or a model", async function () {
    const db = fixture.db
    const one = mintUserId(id => taken.has(id))
    taken.add(one.userId)
    ids.set('Joe Girardi', userIdOfGumbo(one.userId))
    await insertFixtureUsers(db, {
      id: one.userId,
      legacyId: one.legacyId,
      display_name: 'Joe Girardi',
      login_enabled: true
    })
    await db
      .insertInto('season_team_parents')
      .values({ season_id: 'sea_demo', team_id: 'tem_home' })
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: 'sea_demo', team_id: 'tem_home' })
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: idOf('Joe Girardi'),
        scope_type: 'season',
        scope_id: 'sea_demo',
        role: 'coach',
        granted_at: new Date()
      })
      .execute()
    // Mookie's guardian is on the Hawks' list, which the season's coach
    // manages; the stranger is on no list of the season.
    const asked = [idOf('Ken Griffey'), idOf('Aaron Judge')]
    expect([
      ...(await fullNamesFor(db, reader('Joe Girardi'), asked))
    ]).deep.equals([idOf('Ken Griffey')])
    const person: Actor = {
      userId: idOf('Joe Girardi'),
      isAdmin: false,
      scopes: []
    }
    expect(
      (
        await fullNamesFor(
          db,
          readerOf({ ...person, apiTokenId: 'tok_machine' }),
          asked
        )
      ).size
    ).equals(0)
    expect(
      (
        await runSpoken(
          async () => await fullNamesFor(db, reader('Joe Girardi'), asked)
        )
      ).size
    ).equals(0)
  })

  it('asks about a list of fifty in as many queries as about two', async function () {
    const others: string[] = []
    for (let i = 0; i < 48; i++) {
      const one = mintUserId(id => taken.has(id))
      taken.add(one.userId)
      others.push(userIdOfGumbo(one.userId))
      await insertFixtureUsers(fixture.db, {
        id: one.userId,
        legacyId: one.legacyId,
        display_name: `Demo Player ${i}`
      })
    }
    const counted = (): { db: Kysely<Database>; queries: () => number } => {
      let queries = 0
      return {
        db: fixture.db.withPlugin({
          transformQuery(args) {
            queries++
            return args.node
          },
          async transformResult(args) {
            return args.result
          }
        }),
        queries: () => queries
      }
    }
    const two = counted()
    const few = await fullNamesFor(two.db, reader('Bruce Bochy'), [
      idOf('Mookie Betts'),
      others[0]
    ])
    const fifty = counted()
    const many = await fullNamesFor(fifty.db, reader('Bruce Bochy'), [
      idOf('Mookie Betts'),
      ...others,
      idOf('Aaron Judge')
    ])
    expect([...few]).deep.equals([idOf('Mookie Betts')])
    expect([...many]).deep.equals([idOf('Mookie Betts')])
    expect(fifty.queries()).equals(two.queries())
  })

  it('takes an answer the caller already has without asking again, and still none for a model', async function () {
    let queries = 0
    const db = fixture.db.withPlugin({
      transformQuery(args) {
        queries++
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    const player = idOf('Mookie Betts')
    const known = await fullNamesFor(
      db,
      reader('Bruce Bochy'),
      [player, idOf('Aaron Judge')],
      { known: [player, idOf('Ken Griffey')] }
    )
    expect([...known]).deep.equals([player])
    expect(queries).equals(0)
    expect(
      (
        await runSpoken(
          async () =>
            await fullNamesFor(db, reader('Bruce Bochy'), [player], {
              known: [player]
            })
        )
      ).size
    ).equals(0)
    expect(
      (await fullNamesFor(db, undefined, [player], { known: [player] })).size
    ).equals(0)
  })

  it('takes the reader from a person, never from a machine', function () {
    const person: Actor = { userId: 'usr_person', isAdmin: true, scopes: [] }
    expect(readerOf(person)).deep.equals({
      userId: 'usr_person',
      isAdmin: true
    })
    expect(
      readerOf({
        ...person,
        apiKey: { id: 'key_person', permissions: new Set() }
      })
    ).deep.equals({ userId: 'usr_person', isAdmin: true })
    expect(readerOf({ ...person, apiTokenId: 'tok_machine' })).equals(undefined)
    expect(readerOf({ ...person, viaTess: true })).equals(undefined)
    expect(readerOf(undefined)).equals(undefined)
  })
})
