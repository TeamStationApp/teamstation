import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import {
  type GuardianFixture,
  guardianFixture
} from '../../test/guardianFixture'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { visibleScopes } from '../access'
import { affiliationText, personAffiliations } from './personAffiliations'
import { runSpoken } from './readerNames'

/**
 * The affiliation line beside a person on every list (`personAffiliations`).
 *
 * From `guardianFixture`: Babe Ruth (101) administers League A, whose
 * seasons hold Demo Hawks and Demo Comets; Ichiro (104) coaches Demo Hawks
 * only; Hank Majeski (208) runs Demo Rookies, outside the league; Tim Raines
 * (106) guards Alfonso Soriano (201), who plays on Demo Hawks and Demo
 * Comets; Ben Chapman (202) and Cody Decker (203) play on Demo Hawks.
 */
describe('person affiliations', function () {
  this.timeout(60000)
  let f: GuardianFixture
  beforeEach(async () => {
    f = await guardianFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  const id = userIdOfGumbo
  const link = async (
    guardian: number,
    player: number,
    kind: 'guardian' | 'family' = 'guardian'
  ): Promise<void> => {
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: id(guardian),
        related_user_id: id(player),
        kind,
        can_manage: kind === 'guardian',
        created_at: new Date()
      })
      .execute()
  }
  const plays = async (
    userId: number,
    teamId: string,
    isPlayer = true
  ): Promise<void> => {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: id(userId),
        team_id: teamId,
        role: 'member',
        is_player: isPlayer
      })
      .execute()
  }
  /** Each asked person's line, as `reader` reads it with their own scopes. */
  const linesFor = async (
    reader: number,
    people: number[],
    options: {
      onTeam?: string
      teams?: ReadonlySet<string>
      readsFull?: ReadonlySet<string>
    } = {}
  ): Promise<string[]> => {
    const lines = await personAffiliations(f.h.db, people.map(id), {
      reader: { userId: id(reader), isAdmin: false },
      scopes: await visibleScopes(f.h.db, id(reader), false),
      ...options
    })
    return people.map(person => lines.get(id(person))!)
  }

  it('words the parts in order: guarded players, guardians, family, then teams', function () {
    expect(affiliationText([], [], [])).equals('')
    expect(
      affiliationText(
        ['Demo Hawks', 'Demo Hawks'],
        ['Cody D', 'Cody D'],
        ['Tim R']
      )
    ).equals('Guardian of Cody D · Guardians: Tim R · Demo Hawks')
    expect(
      affiliationText(
        ['Demo Hawks'],
        ['Cody D'],
        ['Tim R'],
        ['Ben C', 'Ben C'],
        ['Rod C']
      )
    ).equals(
      'Guardian of Cody D · Guardians: Tim R · Family of Ben C · Family: Rod C · Demo Hawks'
    )
  })

  it('names family by a family link after the guardians, by the same rules', async function () {
    // Rod is family of Alfonso, on no level of his own.
    await insertFixtureUsers(f.h.db, {
      id: 233,
      display_name: 'Rod Carew',
      first_name: 'Rod',
      last_name: 'Carew'
    })
    await link(233, 201, 'family')
    // The league's administrator reads Rod in full, through his player.
    expect(await linesFor(101, [201, 233])).deep.equals([
      'Guardians: Tim Raines · Family: Rod Carew · Demo Comets, Demo Hawks',
      'Family of Alfonso Soriano · Demo Comets, Demo Hawks'
    ])
    // A league member reads both in the public format.
    await f.h.db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        league_id: f.leagueA,
        user_id: id(f.people.follower),
        role: 'member'
      })
      .execute()
    expect(await linesFor(f.people.follower, [201, 233])).deep.equals([
      'Guardians: Tim R · Family: Rod C · Demo Comets, Demo Hawks',
      'Family of Alfonso S · Demo Comets, Demo Hawks'
    ])
    // The Hawks' coach sees the Hawks only; Hank, who sees neither team,
    // reads no family at all.
    expect(await linesFor(104, [233])).deep.equals([
      'Family of Alfonso Soriano · Demo Hawks'
    ])
    expect(await linesFor(208, [201, 233])).deep.equals(['', ''])
    // On a team's own list, only family of somebody on it.
    expect(await linesFor(101, [201, 233], { onTeam: f.teamA })).deep.equals([
      'Guardians: Tim Raines · Family: Rod Carew',
      'Family of Alfonso Soriano'
    ])
    expect(await linesFor(101, [201, 233], { onTeam: f.rookies })).deep.equals([
      '',
      ''
    ])
  })

  it('lines up a player, a staff member, a guardian, and somebody who is all three', async function () {
    // Ben guards Cody, is guarded by Tim, and plays on Demo Hawks.
    await link(202, 203)
    await link(106, 202)
    expect(await linesFor(101, [201, 104, 106, 202])).deep.equals([
      'Guardians: Tim Raines · Demo Comets, Demo Hawks',
      'Demo Hawks',
      // A guardian's teams are their players'.
      'Guardian of Alfonso Soriano, Ben Chapman · Demo Comets, Demo Hawks',
      'Guardian of Cody Decker · Guardians: Tim Raines · Demo Hawks'
    ])
  })

  it('takes whom the caller found the reader reads in full for the people asked, and asks for the rest', async function () {
    // A league member sees the league's teams and may read nobody here in
    // full; the caller says he reads Alfonso so, and that is taken for
    // Alfonso when he is asked about.
    await f.h.db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        league_id: f.leagueA,
        user_id: id(f.people.follower),
        role: 'member'
      })
      .execute()
    const told = new Set([id(201)])
    expect(
      await linesFor(f.people.follower, [201, 106], { readsFull: told })
    ).deep.equals([
      'Guardians: Tim R · Demo Comets, Demo Hawks',
      'Guardian of Alfonso Soriano · Demo Comets, Demo Hawks'
    ])
    // Not asked about, Alfonso is asked for, whatever the caller says.
    expect(
      await linesFor(f.people.follower, [106], { readsFull: told })
    ).deep.equals(['Guardian of Alfonso S · Demo Comets, Demo Hawks'])
    // The league's administrator, told he reads nobody in full, still reads
    // Tim in full beside Alfonso: Tim was not asked about.
    expect(await linesFor(101, [201], { readsFull: new Set() })).deep.equals([
      'Guardians: Tim Raines · Demo Comets, Demo Hawks'
    ])
  })

  it('names people in full for whoever may read them so, and in the public format otherwise', async function () {
    // A league member sees the league's teams and manages nobody.
    await f.h.db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        league_id: f.leagueA,
        user_id: id(f.people.follower),
        role: 'member'
      })
      .execute()
    // The league's administrator reads Tim, on no level, in full through
    // his child's team.
    expect(await linesFor(101, [201, 106])).deep.equals([
      'Guardians: Tim Raines · Demo Comets, Demo Hawks',
      'Guardian of Alfonso Soriano · Demo Comets, Demo Hawks'
    ])
    expect(await linesFor(f.people.follower, [201, 106])).deep.equals([
      'Guardians: Tim R · Demo Comets, Demo Hawks',
      'Guardian of Alfonso S · Demo Comets, Demo Hawks'
    ])
  })

  it('leaves out a team, a guarded player and guardians the reader may not see', async function () {
    // Willie plays on Demo Rookies, which only Hank may see; Tim guards him.
    await insertFixtureUsers(f.h.db, {
      id: 230,
      display_name: 'Willie Mays',
      first_name: 'Willie',
      last_name: 'Mays'
    })
    await plays(230, f.rookies)
    await link(106, 230)
    // The Hawks' coach sees the Hawks, not the Comets, nor Willie.
    expect(await linesFor(104, [201, 106])).deep.equals([
      'Guardians: Tim Raines · Demo Hawks',
      'Guardian of Alfonso Soriano · Demo Hawks'
    ])
    // Hank sees Willie and his guardian, and nobody on the league's teams.
    expect(await linesFor(208, [106, 230, 201])).deep.equals([
      'Guardian of Willie Mays · Demo Rookies',
      'Guardians: Tim Raines · Demo Rookies',
      ''
    ])
  })

  it('shows a guardian the players they guard on no team', async function () {
    await insertFixtureUsers(f.h.db, {
      id: 231,
      display_name: 'Ken Griffey',
      first_name: 'Ken',
      last_name: 'Griffey'
    })
    await link(106, 231)
    // Tim sees the child he guards; the league's administrator does not.
    expect(await linesFor(106, [106])).deep.equals([
      'Guardian of Alfonso Soriano, Ken Griffey · Demo Comets, Demo Hawks'
    ])
    expect(await linesFor(101, [106])).deep.equals([
      'Guardian of Alfonso Soriano · Demo Comets, Demo Hawks'
    ])
  })

  it('on a team’s own list names no team, and only family on that team', async function () {
    await insertFixtureUsers(f.h.db, {
      id: 230,
      display_name: 'Willie Mays',
      first_name: 'Willie',
      last_name: 'Mays'
    })
    await plays(230, f.rookies)
    await link(106, 230)
    expect(
      await linesFor(101, [201, 106, 104], { onTeam: f.teamA })
    ).deep.equals(['Guardians: Tim Raines', 'Guardian of Alfonso Soriano', ''])
    // On Demo Rookies, Hank reads Tim beside Willie only.
    expect(await linesFor(208, [106, 230], { onTeam: f.rookies })).deep.equals([
      'Guardian of Willie Mays',
      'Guardians: Tim Raines'
    ])
    // Alfonso is not on Demo Rookies: his guardians are not its to list.
    expect(await linesFor(101, [201], { onTeam: f.rookies })).deep.equals([''])
  })

  it('names only the teams asked for, and only open ones', async function () {
    expect(
      await linesFor(101, [201], { teams: new Set([f.teamA]) })
    ).deep.equals(['Guardians: Tim Raines · Demo Hawks'])
    await f.h.db
      .updateTable('teams')
      .set({ merged_into: f.teamA })
      .where('id', '=', f.secondTeam)
      .execute()
    expect(await linesFor(101, [201])).deep.equals([
      'Guardians: Tim Raines · Demo Hawks'
    ])
  })

  it('answers for the person a merged row was closed into', async function () {
    await insertFixtureUsers(f.h.db, {
      id: 232,
      display_name: 'Tim Raines',
      first_name: 'Tim',
      last_name: 'Raines',
      merged_into: id(106)
    })
    await link(232, 202)
    expect(await linesFor(101, [106, 202])).deep.equals([
      'Guardian of Alfonso Soriano, Ben Chapman · Demo Comets, Demo Hawks',
      'Guardians: Tim Raines · Demo Hawks'
    ])
  })

  it('lists nothing private without scopes, nothing for nobody, and nothing to a model', async function () {
    const lines = await personAffiliations(f.h.db, [id(201), id(106)], {
      reader: { userId: id(101), isAdmin: false }
    })
    expect([...lines]).deep.equals([
      [id(201), ''],
      [id(106), '']
    ])
    expect(await personAffiliations(f.h.db, [], {})).deep.equals(new Map())
    // Nor for a model, whatever the reader may see.
    const spoken = await runSpoken(
      async () =>
        await personAffiliations(f.h.db, [id(201)], {
          reader: { userId: id(101), isAdmin: false },
          scopes: await visibleScopes(f.h.db, id(101), false)
        })
    )
    expect([...spoken]).deep.equals([[id(201), '']])
  })

  it('reads a list of fifty in the same queries as a list of two', async function () {
    const many = Array.from({ length: 48 }, (_, n) => 300 + n)
    await insertFixtureUsers(
      f.h.db,
      many.map(n => ({
        id: n,
        display_name: `Demo Player${n} Ohtani`,
        first_name: `Demo Player${n}`,
        last_name: 'Ohtani'
      }))
    )
    for (const n of many) {
      await plays(n, n % 2 === 0 ? f.teamA : f.secondTeam)
      await link(106, n)
    }
    let queries = 0
    const db = f.h.db.withPlugin({
      transformQuery(args) {
        queries++
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    const scopes = await visibleScopes(f.h.db, id(101), false)
    const count = async (people: number[]): Promise<number> => {
      queries = 0
      await personAffiliations(db, people.map(id), {
        reader: { userId: id(101), isAdmin: false },
        scopes
      })
      return queries
    }
    const two = await count([201, 106])
    const fifty = await count([201, 106, ...many])
    expect(fifty).equals(two)
  })
})
