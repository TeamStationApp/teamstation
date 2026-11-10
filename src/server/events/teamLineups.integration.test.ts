import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type {
  Lineup,
  LineupPerson,
  StoredLineup,
  StoredLineupPerson
} from '../../common/scoring/lineupHistory'
import { POSITIONS } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { statsDatabase } from '../../test/statsDatabase'
import { defaultOf, resolvedDefaultOf, storedLineupOf } from './teamLineups'

const TEAM = 'tem_home'

/** A defense with `fielders` and nobody else. */
function defenseOf<T>(
  fielders: Partial<Record<(typeof POSITIONS)[number], T>>
): Record<(typeof POSITIONS)[number], T | null> {
  return Object.fromEntries(
    POSITIONS.map(position => [position, fielders[position] ?? null])
  ) as Record<(typeof POSITIONS)[number], T | null>
}

describe("a team's default lineup, stored by id and read named", function () {
  this.timeout(60000)
  const fixture = statsDatabase('team_lineups')
  const taken = new Set<number>()
  const mint = (): { userId: number; legacyId: string } => {
    const one = mintUserId(id => taken.has(id))
    taken.add(one.userId)
    return one
  }
  const people = {
    smith: mint(),
    smyly: mint(),
    betts: mint(),
    guest: mint()
  }
  const id = (who: { userId: number }): number => who.userId

  before(async () => {
    for (const [who, first, last] of [
      [people.smith, 'Will', 'Smith'],
      [people.smyly, 'Will', 'Smyly'],
      [people.betts, 'Mookie', 'Betts'],
      [people.guest, 'Kyle', 'Tucker']
    ] as const)
      await insertFixtureUsers(fixture.db, {
        id: who.userId,
        legacyId: who.legacyId,
        display_name: `${first} ${last}`,
        first_name: first,
        last_name: last,
        login_enabled: false
      })
    // The guest played for the team without joining it.
    await fixture.db
      .insertInto('memberships')
      .values(
        [people.smith, people.smyly, people.betts].map(who => ({
          id: makeId('membership'),
          user_id: userIdOfGumbo(who.userId),
          team_id: TEAM,
          is_player: true
        }))
      )
      .execute()
  })

  /** The default a live post stores: Smith, a placeholder, Betts, a guest. */
  const stored = (): {
    lineup: StoredLineup
    fromGameId: string
    setAt: string
  } => {
    const smith: StoredLineupPerson = {
      gumboId: id(people.smith),
      jersey: '16'
    }
    const typed: StoredLineupPerson = {
      gumboId: null,
      name: 'Typed Fielder',
      jersey: ''
    }
    const betts: StoredLineupPerson = {
      gumboId: id(people.betts),
      jersey: '50'
    }
    const guest: StoredLineupPerson = { gumboId: id(people.guest), jersey: '' }
    return {
      lineup: {
        batters: [smith, typed, betts, guest],
        defense: defenseOf({ C: smith, LF: typed, RF: betts, '3B': guest })
      },
      fromGameId: 'gam_demo',
      setAt: '2026-04-01T18:00:00.000Z'
    }
  }

  it('reads a stored default whose players have no names, and none for one that does not read', () => {
    const value = stored()
    expect(
      defaultOf(value)?.lineup?.batters.map(row => row.gumboId)
    ).deep.equals([id(people.smith), null, id(people.betts), id(people.guest)])
    expect(defaultOf(value)?.lineup?.batters[1].name).equals('Typed Fielder')
    expect(defaultOf(null)).equals(null)
    expect(defaultOf({ lineup: null, fromGameId: null, setAt: null })).equals(
      null
    )
    expect(defaultOf({ lineup: { batters: 'nonsense' } })).equals(null)
    expect(
      defaultOf({
        ...value,
        lineup: { ...value.lineup, batters: [{ gumboId: 1, name: 7 }] }
      })
    ).equals(null)
  })

  it('stores a lineup by ids and jerseys, keeping only a placeholder’s typed name', () => {
    const lineup: Lineup = {
      batters: [
        { gumboId: id(people.smith), name: 'Will Smi', jersey: '16' },
        { gumboId: null, name: 'Typed Fielder', jersey: '' }
      ],
      defense: defenseOf({
        C: { gumboId: id(people.smith), name: 'Will Smi', jersey: '16' },
        LF: { gumboId: null, name: 'Typed Fielder', jersey: '' }
      })
    }
    expect(storedLineupOf(lineup)).deep.equals({
      batters: [
        { gumboId: id(people.smith), jersey: '16' },
        { gumboId: null, name: 'Typed Fielder', jersey: '' }
      ],
      defense: defenseOf({
        C: { gumboId: id(people.smith), jersey: '16' },
        LF: { gumboId: null, name: 'Typed Fielder', jersey: '' }
      })
    })
  })

  it("names each player from his account, by the short names of the team's roster", async () => {
    const read = await resolvedDefaultOf(fixture.db, TEAM, stored())
    // Smyly is on the roster and not in the lineup: Smith still reads apart
    // from him. The guest is named though he is no member; the placeholder
    // keeps his typed name.
    const smith: LineupPerson = {
      gumboId: id(people.smith),
      name: 'Will Smi',
      jersey: '16'
    }
    const typed: LineupPerson = {
      gumboId: null,
      name: 'Typed Fielder',
      jersey: ''
    }
    const betts: LineupPerson = {
      gumboId: id(people.betts),
      name: 'Mookie B',
      jersey: '50'
    }
    const guest: LineupPerson = {
      gumboId: id(people.guest),
      name: 'Kyle T',
      jersey: ''
    }
    expect(read).deep.equals({
      lineup: {
        batters: [smith, typed, betts, guest],
        defense: defenseOf({ C: smith, LF: typed, RF: betts, '3B': guest })
      },
      fromGameId: 'gam_demo',
      setAt: '2026-04-01T18:00:00.000Z'
    })
  })

  it('reads a name stored before ids were kept as the account reads now', async () => {
    const value = stored()
    value.lineup.batters[0] = { ...value.lineup.batters[0], name: 'Old Name' }
    const read = await resolvedDefaultOf(fixture.db, TEAM, value)
    expect(read?.lineup?.batters[0].name).equals('Will Smi')
  })

  it('follows a rename, with nothing stored changing', async () => {
    const value = stored()
    const before = JSON.stringify(value)
    await fixture.db
      .updateTable('users')
      .set({
        first_name: 'Max',
        last_name: 'Muncy',
        display_name: 'Max Muncy'
      })
      .where('id', '=', userIdOfGumbo(people.smith.userId))
      .execute()
    try {
      const read = await resolvedDefaultOf(fixture.db, TEAM, value)
      expect(read?.lineup?.batters.map(row => row.name)).deep.equals([
        'Max M',
        'Typed Fielder',
        'Mookie B',
        'Kyle T'
      ])
      expect(read?.lineup?.defense.C?.name).equals('Max M')
      expect(JSON.stringify(value)).equals(before)
    } finally {
      await fixture.db
        .updateTable('users')
        .set({
          first_name: 'Will',
          last_name: 'Smith',
          display_name: 'Will Smith'
        })
        .where('id', '=', userIdOfGumbo(people.smith.userId))
        .execute()
    }
  })
})
