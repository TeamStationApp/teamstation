import { mock } from 'node:test'

import { expect } from 'chai'
import type { CompiledQuery, Kysely } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { withQueryReplies } from '../../test/queryReplies'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { recheckUmpireAssignments, umpireRechecker } from './assignments'
import * as context from './context'

/**
 * `umpireRechecker` against `recheckUmpireAssignments` called for each game
 * in turn, on games and assignments kept in memory: the same assignments
 * taken away, in the same order, and the same screen scopes announced. Who
 * plays for which team is stubbed; the recheck's own statements run
 * against the rows.
 */

type Row = Record<string, unknown>

/** Who plays for which team. */
const PLAYS: Record<string, string[]> = { usr_playing: ['tem_a'] }

const at = (hour: number): Date =>
  new Date(`2027-04-10T${String(hour).padStart(2, '0')}:00:00Z`)

function game(
  id: string,
  start: number,
  end: number | null,
  more: Row = {}
): Row {
  return {
    id,
    home_team_id: 'tem_a',
    away_team_id: 'tem_b',
    start_at: at(start),
    end_at: end == null ? null : at(end),
    status: 'scheduled',
    withdrawn_at: null,
    ...more
  }
}

function assignment(gameId: string, slot: string, userId: string): Row {
  return { game_id: gameId, slot, user_id: userId }
}

interface Memory {
  games: Row[]
  assignments: Row[]
  /** Each assignment taken away, in order. */
  removed: string[]
  /** What each `pg_notify` announced. */
  announced: unknown[]
  statements: string[]
}

function memory(assignments: Row[]): Memory {
  return {
    games: [
      // Published: nobody umpires it; the playing umpire plays in it.
      game('gam_published', 10, 12),
      // Overlaps it, umpired by the playing umpire twice over and by one
      // who plays for nobody.
      game('gam_overlapping', 11, 13, { home_team_id: 'tem_c' }),
      game('gam_alsoOverlapping', 11, 12, { home_team_id: 'tem_c' }),
      // Clear of it.
      game('gam_later', 15, 17, { home_team_id: 'tem_c' }),
      game('gam_cancelled', 10, 12, { status: 'cancelled' }),
      // Published with an umpire of its own, who umpires a game it overlaps
      // with no end of its own.
      game('gam_edited', 18, 20, { home_team_id: 'tem_d' }),
      game('gam_openEnded', 19, null, { home_team_id: 'tem_e' }),
      // Published and withdrawn at once: nobody's assignment goes for it.
      game('gam_withdrawn', 11, 12, { withdrawn_at: at(9) })
    ],
    assignments: assignments.map(each => ({ ...each })),
    removed: [],
    announced: [],
    statements: []
  }
}

const ASSIGNMENTS = [
  assignment('gam_overlapping', 'plate:1', 'usr_playing'),
  assignment('gam_overlapping', 'base:1', 'usr_free'),
  assignment('gam_alsoOverlapping', 'plate:1', 'usr_playing'),
  assignment('gam_later', 'plate:1', 'usr_playing'),
  assignment('gam_cancelled', 'plate:1', 'usr_playing'),
  assignment('gam_edited', 'plate:1', 'usr_busy'),
  assignment('gam_openEnded', 'plate:1', 'usr_busy')
]

const PUBLISHED = ['gam_published', 'gam_edited', 'gam_withdrawn']

const active = (row: Row): boolean =>
  row.status !== 'cancelled' && row.withdrawn_at == null

function reply(m: Memory): (query: CompiledQuery) => unknown[] {
  return query => {
    const { sql } = query
    const p = query.parameters
    m.statements.push(sql)
    if (sql === 'select * from "umpire_assignments"')
      return m.assignments.map(each => ({ ...each }))
    if (sql.startsWith('select * from "games" where "id" = $1'))
      return m.games.filter(row => row.id === p[0])
    if (sql.startsWith('select * from "games" where "id" in'))
      return m.games.filter(row => p.includes(row.id))
    // Every game not cancelled: what the windowed read narrows is only
    // ever a superset of what the rule looks at.
    if (sql.startsWith('select * from "games" where "status" != $1'))
      return m.games.filter(active)
    if (sql.startsWith('delete from "umpire_assignments"')) {
      m.removed.push(`${String(p[0])} ${String(p[1])}`)
      m.assignments = m.assignments.filter(
        row => row.game_id !== p[0] || row.slot !== p[1]
      )
      return []
    }
    if (sql.includes('pg_notify')) m.announced.push(p)
    return []
  }
}

async function run(
  m: Memory,
  work: (db: Kysely<Database>) => Promise<void>
): Promise<void> {
  await withQueryReplies(reply(m), async db => {
    await atomic(db, async trx => {
      await work(trx)
    })
  })
}

describe('rechecking umpire assignments for many games from one read', () => {
  let identities: string[]
  beforeEach(() => {
    identities = []
    mock.method(context, 'umpireIdentity', async (_db: unknown, id: string) => {
      identities.push(id)
      return {
        userId: id,
        userIds: [id],
        name: id,
        displayName: id,
        named: { id, firstName: null, lastName: null, displayName: id },
        avatarPath: null,
        active: true,
        gumboIds: [],
        teamIds: PLAYS[id] ?? []
      }
    })
  })
  afterEach(() => {
    mock.restoreAll()
  })

  it('takes away what rechecking each game in turn takes away, in its order, announcing the same', async () => {
    const alone = memory(ASSIGNMENTS)
    await run(alone, async trx => {
      for (const id of PUBLISHED)
        await recheckUmpireAssignments(trx as never, id)
    })
    const aloneIdentities = identities.length
    identities = []
    const together = memory(ASSIGNMENTS)
    await run(together, async trx => {
      const recheck = await umpireRechecker(trx as never, PUBLISHED)
      for (const id of PUBLISHED) await recheck(id)
    })
    expect(alone.removed).deep.equals([
      'gam_overlapping plate:1',
      'gam_alsoOverlapping plate:1',
      'gam_edited plate:1'
    ])
    expect(together.removed).deep.equals(alone.removed)
    expect(together.assignments).deep.equals(alone.assignments)
    expect(together.announced).deep.equals(alone.announced)
    expect(together.announced).lengthOf(1)
    // Read once: the assignments, the published games, and the games they
    // could touch, the edited game's window among them.
    const reads = together.statements.filter(sql => sql.startsWith('select *'))
    expect(reads).lengthOf(3)
    expect(reads[2]).includes('coalesce(end_at, start_at +')
    expect(alone.statements.filter(sql => sql.startsWith('select *'))).lengthOf(
      9
    )
    // Each umpire's account read once, not once for each assignment.
    expect(identities).deep.equals(['usr_playing', 'usr_free', 'usr_busy'])
    expect(aloneIdentities).greaterThan(identities.length)
  })

  it('reads nothing more when nobody umpires, and refuses a game it was not given', async () => {
    const empty = memory([])
    await run(empty, async trx => {
      const recheck = await umpireRechecker(trx as never, PUBLISHED)
      for (const id of PUBLISHED) await recheck(id)
      // No games to recheck: nothing past the assignments either.
      await (
        await umpireRechecker(trx as never, [])
      )('gam_published')
    })
    expect(
      empty.statements.filter(sql => sql.startsWith('select *'))
    ).deep.equals([
      'select * from "umpire_assignments"',
      'select * from "umpire_assignments"'
    ])
    const m = memory(ASSIGNMENTS)
    let refused: unknown
    await run(m, async trx => {
      const recheck = await umpireRechecker(trx as never, ['gam_published'])
      await recheck('gam_elsewhere').catch((error: unknown) => {
        refused = error
      })
    })
    expect(String(refused)).includes('No game gam_elsewhere to recheck')
    expect(m.removed).deep.equals([])
  })
})
