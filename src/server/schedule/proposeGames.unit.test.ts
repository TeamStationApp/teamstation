import { mock } from 'node:test'

import { expect } from 'chai'
import type { CompiledQuery, Kysely } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { PlannedGame } from '../../common/autoScheduler/types'
import type { GameProposal } from '../../common/gameApprovals'
import { withQueryReplies } from '../../test/queryReplies'
import * as cancel from '../autoScheduler/cancel'
import { proposePlanned } from '../autoScheduler/propose'
import type { Snapshot } from '../autoScheduler/snapshot'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { withRolesRead } from '../db/readOnce'
import * as requests from '../groups/requests'
import * as rights from '../groups/rights'
import { frozenNamesOf } from '../notifications/requestInformation'
import * as teamFacts from '../teams/teamFacts'
import * as umpires from '../umpires/assignments'
import * as fieldWarnings from '../venues/fieldWarnings'
import { proposeGame, proposeGames } from './gameApprovals'
import { seasonGameConsent } from './seasonGameConsent'

/**
 * `proposeGames` against `proposeGame` one game at a time, on a database
 * kept in memory: the same rows written, the same changes told, the same
 * answers and refusals. The rights and the field warnings are stubbed; the
 * proposal path's own statements run against the rows.
 */

type Row = Record<string, unknown>

const actor = { userId: 'usr_sender', isAdmin: false, scopes: [] }
const clock = { now: () => new Date('2027-01-01T00:00:00Z') }

/** One way of proposing, as `bothWays` compares it. */
interface Way {
  rows: ReturnType<typeof named>
  answer: string
  statements: number
  warned: Array<{ fields: unknown[]; games: unknown[] }>
  rechecked: string[]
  /** The games each umpire rechecker was built for. */
  rechecking: string[][]
}

/** The tables the proposal path writes, and what it announced. */
interface Memory {
  tables: Record<string, Row[]>
  told: string[]
  statements: number
  reply: (query: CompiledQuery) => unknown[]
}

/** The rows of a multi-row `values (…), (…)`, by their columns. */
function inserted(
  columns: string[],
  values: string,
  parameters: readonly unknown[]
): Row[] {
  return [...values.matchAll(/\(([^()]*)\)/g)].map(group => {
    const row: Row = {}
    group[1].split(', ').forEach((item, i) => {
      const at = /^\$(\d+)$/.exec(item.trim())
      if (at != null) row[columns[i]] = parameters[Number(at[1]) - 1]
    })
    return row
  })
}

function memory(): Memory {
  const tables: Record<string, Row[]> = {
    group_requests: [],
    group_request_sides: [],
    notification_events: [],
    creation_idempotency: [],
    games: [],
    schedule_preview_games: []
  }
  const told: string[] = []
  const m: Memory = {
    tables,
    told,
    statements: 0,
    reply: query => {
      m.statements++
      const { sql } = query
      const p = query.parameters
      if (sql.startsWith('select pg_advisory_xact_lock')) return []
      if (sql.startsWith('select pg_notify')) {
        told.push(
          ...(Array.isArray(p[1])
            ? (p[1] as string[]).map(payload => `${String(p[0])} ${payload}`)
            : [`${String(p[0])} ${String(p[1])}`])
        )
        return []
      }
      const insert =
        /^insert into "(\w+)" \(([^)]*)\) values (.*?)( returning \*)?$/s.exec(
          sql
        )
      if (insert != null) {
        const columns = insert[2]
          .split(', ')
          .map(column => column.replace(/"/g, ''))
        const rows = inserted(columns, insert[3], p).map(row =>
          insert[1] === 'group_requests'
            ? {
                status: 'pending',
                resolved_at: null,
                resolved_by: null,
                ...row
              }
            : row
        )
        tables[insert[1]] ??= []
        tables[insert[1]].push(...rows)
        return insert[4] == null ? [] : rows.map(row => ({ ...row }))
      }
      const byId = (table: string, column: string, id: unknown): Row[] =>
        tables[table].filter(row => row[column] === id).map(row => ({ ...row }))
      if (
        sql.startsWith(
          'select "body_hash", "response" from "creation_idempotency"'
        )
      )
        return byId('creation_idempotency', 'key', p[1])
      if (
        sql.startsWith(
          'select "key", "body_hash", "response" from "creation_idempotency"'
        )
      )
        return tables.creation_idempotency.filter(row =>
          p.slice(1).includes(row.key)
        )
      if (sql.startsWith('select * from "group_requests" where "id" = $1'))
        return byId('group_requests', 'id', p[0])
      if (
        sql.startsWith(
          'select * from "group_request_sides" where "request_id" = $1'
        )
      )
        return byId('group_request_sides', 'request_id', p[0])
      if (sql.startsWith('select "field_id" from "games" where "id" = $1'))
        return byId('games', 'id', p[0])
      if (
        sql.startsWith(
          'select "home_team_id", "away_team_id", "season_id" from "games" where "id" = $1'
        )
      )
        return byId('games', 'id', p[0])
      if (sql.startsWith('select "id" from "seasons" where "id" = $1'))
        return [{ id: p[0] }]
      if (sql.startsWith('select "name" from "teams" where "id" = $1'))
        return [{ name: `Team ${String(p[0])}` }]
      if (sql.startsWith('select "name" from "seasons" where "id" = $1'))
        return [{ name: `Season ${String(p[0])}` }]
      if (sql.includes('from "venue_fields" inner join "venues"'))
        return [
          {
            sizes: ['50/70'],
            deleted_at: null,
            pin_latitude: null,
            pin_longitude: null,
            name: 'Demo Park',
            address: '1 Demo Way',
            latitude: 1,
            longitude: 2
          }
        ]
      if (sql.startsWith('select "value" from "system_settings"'))
        return [{ value: true }]
      if (sql.startsWith('select "game_key" from "schedule_preview_games"'))
        return byId('schedule_preview_games', 'preview_id', p[0])
      if (
        sql.startsWith(
          'update "notification_events" set "metadata" = metadata ||'
        )
      ) {
        for (const row of tables.notification_events)
          if (row.source_type === p[1] && row.source_id === p[2])
            row.metadata = {
              ...(row.metadata as object),
              frozen: JSON.parse(String(p[0]))
            }
        return []
      }
      if (
        sql.startsWith(
          'update "group_requests" set "status" = $1, "game_id" = $2, "resolved_at" = $3 where "id" = $4'
        )
      ) {
        for (const row of tables.group_requests)
          if (row.id === p[3])
            Object.assign(row, {
              status: p[0],
              game_id: p[1],
              resolved_at: p[2]
            })
        return []
      }
      if (
        sql.startsWith(
          'update "group_requests" set "status" = $1, "game_id" = terms->>\'proposedGameId\', "resolved_at" = $2 where "id" in'
        )
      ) {
        const changed: Row[] = []
        for (const row of tables.group_requests)
          if (p.slice(2).includes(row.id)) {
            Object.assign(row, {
              status: p[0],
              game_id: (row.terms as { proposedGameId: string }).proposedGameId,
              resolved_at: p[1]
            })
            changed.push({ ...row })
          }
        return changed
      }
      if (
        sql.startsWith(
          'update "schedule_preview_games" set "game_id" = $1 where "request_id" = $2'
        )
      )
        return []
      throw new Error(`Unexpected SQL: ${sql}`)
    }
  }
  return m
}

/** The rows and announcements, each id made here named by its key. */
function named(m: Memory): {
  tables: Record<string, string[]>
  told: string[]
} {
  const names = new Map<string, string>()
  for (const held of m.tables.creation_idempotency) {
    const id = (held.response as { id: string }).id
    names.set(id, `<request ${String(held.key)}>`)
    const request = m.tables.group_requests.find(row => row.id === id)
    const game = (request?.terms as { proposedGameId?: string } | undefined)
      ?.proposedGameId
    if (game != null) names.set(game, `<game ${String(held.key)}>`)
  }
  for (const event of m.tables.notification_events)
    names.set(String(event.id), '<audit>')
  const text = (value: unknown): string => {
    let out = JSON.stringify(value)
    for (const [id, name] of names) out = out.split(id).join(name)
    return out
  }
  return {
    tables: Object.fromEntries(
      Object.entries(m.tables).map(([table, rows]) => [
        table,
        rows.map(text).sort()
      ])
    ),
    told: m.told.map(text)
  }
}

function body(
  n: number,
  overrides: Partial<GameProposal['game']> = {}
): GameProposal {
  return {
    sender: { kind: 'season', id: 'sea_a' },
    game: {
      homeTeamId: `tem_home${n}`,
      awayTeamId: `tem_away${n}`,
      seasonId: 'sea_a',
      startAt: `2027-04-0${n}T14:00:00.000Z`,
      endAt: `2027-04-0${n}T16:00:00.000Z`,
      timezone: 'America/New_York',
      venue: null,
      outsideTournament: null,
      status: 'scheduled',
      exhibition: n === 3,
      fieldId: n === 2 ? null : 'fld_a',
      fieldSize: n === 2 ? null : '50/70',
      ...overrides
    },
    idempotencyKey: `schedule:spv_a:game${n}`
  }
}

/** Runs `work` on its own memory, in one transaction as a publication does. */
async function inMemory<T>(
  m: Memory,
  work: (db: Kysely<Database>) => Promise<T>
): Promise<T | { refused: string }> {
  let answer: T | { refused: string } | undefined
  await withQueryReplies(m.reply, async db => {
    try {
      answer = await atomic(
        db,
        async trx => await withRolesRead(trx, async () => await work(trx))
      )
    } catch (error) {
      answer = { refused: (error as Error).message }
    }
  })
  return answer!
}

describe('proposing new games together', () => {
  /** Sides the sender may not approve, as `${teamId}`. */
  let unapproved: Set<string>
  let warned: Array<{ fields: unknown[]; games: unknown[] }>
  let rechecked: string[]
  let rechecking: string[][]
  /** What `requireScheduler` refuses with, if anything. */
  let refusal: string | undefined
  beforeEach(() => {
    unapproved = new Set()
    warned = []
    rechecked = []
    rechecking = []
    mock.method(rights, 'currentActor', async () => actor)
    refusal = undefined
    mock.method(rights, 'requireScheduler', async () => {
      if (refusal != null) throw new Error(refusal)
    })
    mock.method(rights, 'canScheduleFor', async () => true)
    mock.method(
      requests,
      'approvesSide',
      async (_db: unknown, _actor: unknown, side: { id: string }) =>
        !unapproved.has(side.id)
    )
    mock.method(teamFacts, 'teamFacts', async (_db: unknown, id: string) => ({
      id,
      kind: id.startsWith('tem_stub') ? 'external' : 'full',
      custodian_type: id.startsWith('tem_stub') ? 'season' : null,
      custodian_id: id.startsWith('tem_stub') ? 'sea_a' : null,
      merged_into: null
    }))
    mock.method(
      fieldWarnings,
      'refreshFieldWarnings',
      async (
        _db: unknown,
        fields: unknown[],
        _clock: unknown,
        games: unknown[] = []
      ) => {
        warned.push({ fields, games })
      }
    )
    mock.method(
      umpires,
      'recheckUmpireAssignments',
      async (_db: unknown, gameId: string) => {
        rechecked.push(gameId)
      }
    )
    mock.method(
      umpires,
      'umpireRechecker',
      async (_db: unknown, gameIds: readonly string[]) => {
        rechecking.push([...gameIds])
        return async (gameId: string) => {
          rechecked.push(gameId)
        }
      }
    )
  })
  afterEach(() => {
    mock.restoreAll()
  })

  /** Each way, on its own memory: the outcome named, and its statements. */
  const bothWays = async (
    bodies: GameProposal[],
    setup: (m: Memory) => void = () => undefined
  ): Promise<{ oneByOne: Way; together: Way }> => {
    const run = async (together: boolean): Promise<Way> => {
      const m = memory()
      setup(m)
      warned = []
      rechecked = []
      rechecking = []
      const answer = await inMemory(m, async trx =>
        together
          ? await proposeGames(trx, actor, bodies, clock)
          : await (async () => {
              const out = []
              for (const each of bodies)
                out.push(await proposeGame(trx, actor, each, clock))
              return out
            })()
      )
      const rows = named(m)
      // A published game by its proposal's key: its id is drawn afresh.
      const keyOf = (gameId: string): string => {
        const request = m.tables.group_requests.find(
          row =>
            (row.terms as { proposedGameId?: string }).proposedGameId === gameId
        )
        return String(
          m.tables.creation_idempotency.find(
            held => (held.response as { id: string }).id === request?.id
          )?.key
        )
      }
      return {
        rows,
        answer: JSON.stringify(
          Array.isArray(answer)
            ? answer.map(request => ({
                status: request.status,
                kind: request.kind
              }))
            : answer
        ),
        statements: m.statements,
        warned: [...warned],
        rechecked: rechecked.map(keyOf),
        rechecking: rechecking.map(ids => ids.map(keyOf))
      }
    }
    return { oneByOne: await run(false), together: await run(true) }
  }

  it('writes, tells and answers what proposing each alone does, in far fewer statements', async () => {
    unapproved.add('tem_away2')
    const bodies = [1, 2, 3].map(n => body(n))
    bodies.push(body(4, { homeTeamId: 'tem_stub4' }))
    const both = await bothWays(bodies)
    expect(both.together.rows).deep.equals(both.oneByOne.rows)
    expect(both.together.answer).equals(both.oneByOne.answer)
    expect(both.together.answer).includes('"status":"pending"')
    expect(both.together.answer).includes('"status":"accepted"')
    expect(both.together.rows.tables.games).lengthOf(3)
    expect(both.together.statements).below(both.oneByOne.statements / 2)
    // One refresh of every field and published game, not two for each.
    expect(both.together.warned).lengthOf(1)
    expect(both.together.warned[0].fields).deep.equals([
      'fld_a',
      null,
      'fld_a',
      'fld_a'
    ])
    expect(both.together.warned[0].games).lengthOf(3)
    expect(both.oneByOne.warned).lengthOf(4 + 3)
  })

  it('rechecks the umpires of each published game in order, from one read, as one at a time does', async () => {
    unapproved.add('tem_away2')
    const both = await bothWays([1, 2, 3].map(n => body(n)))
    expect(both.together.rows).deep.equals(both.oneByOne.rows)
    // Each published game once, in the order its proposal came.
    expect(both.oneByOne.rechecked).deep.equals([
      'schedule:spv_a:game1',
      'schedule:spv_a:game3'
    ])
    expect(both.together.rechecked).deep.equals(both.oneByOne.rechecked)
    // One rechecker for the published games, not one read for each.
    expect(both.together.rechecking).deep.equals([both.oneByOne.rechecked])
    expect(both.oneByOne.rechecking).deep.equals([])
  })

  it('replays a proposal sent before, and refuses one sent again with other details, alike', async () => {
    const before = (m: Memory): void => {
      m.tables.group_requests.push({
        id: 'inv_before',
        kind: 'game',
        status: 'accepted',
        terms: { kind: 'game', game: {} }
      })
      m.tables.creation_idempotency.push({
        user_id: actor.userId,
        key: 'schedule:spv_a:game1',
        body_hash: 'another body',
        response: { id: 'inv_before', gameProposalVersion: 2 }
      })
    }
    const refused = await bothWays([body(1), body(2)], before)
    expect(refused.together.answer).equals(refused.oneByOne.answer)
    expect(refused.together.answer).includes(
      'already submitted with different game details'
    )
    // The same body again answers the request it made.
    const first = memory()
    await inMemory(
      first,
      async trx => await proposeGames(trx, actor, [body(1)], clock)
    )
    const again = await bothWays([body(1), body(2)], m => {
      for (const [table, rows] of Object.entries(first.tables))
        m.tables[table] = rows.map(row => ({ ...row }))
    })
    expect(again.together.rows).deep.equals(again.oneByOne.rows)
    expect(again.together.answer).equals(again.oneByOne.answer)
  })

  it('refuses as one at a time refuses, before writing anything', async () => {
    refusal = 'Only an administrator may schedule for this group'
    const both = await bothWays([body(1), body(2)])
    expect(both.together.answer).equals(both.oneByOne.answer)
    expect(both.together.rows.tables.group_requests).deep.equals([])
  })

  it('proposes two bodies with one key one at a time, so the second answers the first', async () => {
    const m = memory()
    const answer = await inMemory(
      m,
      async trx => await proposeGames(trx, actor, [body(1), body(1)], clock)
    )
    expect(Array.isArray(answer)).equals(true)
    const [one, two] = answer as Array<{ id: string }>
    expect(two.id).equals(one.id)
    expect(m.tables.group_requests).lengthOf(1)
  })

  it('proposes games with an open side as one at a time does, asking only the named teams', async () => {
    const bodies = [
      body(5, { awayTeamId: null }),
      body(6, { homeTeamId: null, awayTeamId: null })
    ]
    const both = await bothWays(bodies)
    expect(both.together.rows).deep.equals(both.oneByOne.rows)
    expect(both.together.answer).equals(both.oneByOne.answer)
    const games = both.together.rows.tables.games.map(
      row => JSON.parse(row) as Record<string, unknown>
    )
    expect(games.map(row => [row.home_team_id, row.away_team_id])).deep.members(
      [
        [null, null],
        ['tem_home5', null]
      ]
    )
    // One side asked of the one-side game, none of the both-open one.
    const sides = both.together.rows.tables.group_request_sides.map(
      row => JSON.parse(row) as Record<string, unknown>
    )
    expect(sides.map(side => side.scope_id)).deep.equals(['tem_home5'])
    // Its named team is told; nobody is told of an open side.
    expect(both.together.rows.told.join(' ')).not.includes('null')
  })

  it('answers nothing for no games', async () => {
    const nothing: object = {}
    expect(
      await proposeGames(nothing as Kysely<Database>, actor, [], clock)
    ).deep.equals([])
  })

  it('records a preview’s games and counts them for its teams the same either way', async () => {
    unapproved.add('tem_away2')
    const snap = {
      engine: {
        fields: [
          { id: 'fld_a', availability: { timezone: 'America/New_York' } }
        ]
      }
    } as unknown as Snapshot
    const planned: PlannedGame[] = [1, 2, 3].map(n => {
      const each = body(n)
      return {
        key: `game${n}`,
        seasonId: 'sea_a',
        homeTeamId: each.game.homeTeamId!,
        awayTeamId: each.game.awayTeamId!,
        startAt: each.game.startAt,
        endAt: each.game.endAt!,
        fieldId: n === 2 ? 'fld_b' : 'fld_a',
        size: '50/70',
        exhibition: n === 3
      }
    })
    const run = async (
      oneByOne: boolean
    ): Promise<{ rows: ReturnType<typeof named>; tallies: string }> => {
      const m = memory()
      m.tables.schedule_preview_games.push({
        preview_id: 'spv_a',
        game_key: 'game3'
      })
      const tallies: cancel.Tallies = new Map()
      await inMemory(m, async trx => {
        await proposePlanned(
          trx,
          actor,
          'spv_a',
          snap,
          planned,
          clock,
          tallies,
          { oneByOne }
        )
      })
      return {
        rows: named(m),
        tallies: JSON.stringify(
          [...tallies].map(([id, t]) => [
            id,
            { ...t, seasonIds: [...t.seasonIds] }
          ])
        )
      }
    }
    const oneByOne = await run(true)
    const together = await run(false)
    expect(together).deep.equals(oneByOne)
    expect(together.rows.tables.schedule_preview_games).lengthOf(3)
    expect(together.tallies).includes('"awaiting":1')
    // Nothing to propose, nothing read.
    const m = memory()
    await inMemory(m, async trx => {
      await proposePlanned(trx, actor, 'spv_a', snap, [], clock, new Map())
    })
    expect(m.statements).equals(0)
  })
})

describe('cancelling and telling a publication’s teams', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('tells each cancelled game’s screens in one statement, and records every team’s notice in another', async () => {
    const told: string[] = []
    const notes: string[] = []
    mock.method(fieldWarnings, 'refreshFieldWarnings', async () => undefined)
    mock.method(
      rights,
      'schedulingRecipients',
      async (_db: unknown, refs: Array<{ id: string }>) =>
        refs[0].id === 'tem_nobody'
          ? []
          : [`usr_${refs[0].id}`, `usr_${refs[0].id}`]
    )
    const tallies: cancel.Tallies = new Map()
    const statements: string[] = []
    await withQueryReplies(
      query => {
        statements.push(query.sql.split(' ').slice(0, 3).join(' '))
        if (query.sql.startsWith('update "games"'))
          return [
            {
              id: 'gam_1',
              field_id: 'fld_a',
              home_team_id: 'tem_a',
              away_team_id: 'tem_b',
              season_id: 'sea_a'
            },
            {
              id: 'gam_2',
              field_id: null,
              home_team_id: 'tem_b',
              away_team_id: 'tem_nobody',
              season_id: null
            }
          ]
        if (query.sql.startsWith('select pg_notify'))
          (query.parameters[0] === 'game_changes' ? told : notes).push(
            ...(query.parameters[1] as string[])
          )
        if (query.sql.startsWith('select "id", "name" from "teams"'))
          return [{ id: 'tem_a', name: 'Demo Hawks' }]
        if (query.sql.startsWith('select "id", "name" from "seasons"'))
          return [{ id: 'sea_a', name: 'Spring' }]
        if (query.sql.startsWith('insert into "notification_events"')) {
          expect(
            query.parameters.filter(value => value === 'schedulePublished')
          ).lengthOf(2)
          expect(query.parameters).deep.include(['usr_tem_a'])
        }
        return []
      },
      async db => {
        await atomic(db, async trx => {
          expect(
            await cancel.cancelAsRescheduled(
              trx,
              ['gam_1', 'gam_2'],
              clock,
              actor.userId,
              tallies
            )
          ).deep.equals(['gam_1', 'gam_2'])
          await cancel.noticeTeams(trx, tallies, { actorId: actor.userId })
        })
      }
    )
    expect(told).deep.equals([
      JSON.stringify({ game: 'gam_1', kind: 'game' }),
      JSON.stringify({ game: 'gam_2', kind: 'game' })
    ])
    expect(notes.map(each => JSON.parse(each))).deep.equals([
      { gameId: 'gam_1' },
      { teamId: 'tem_a' },
      { teamId: 'tem_b' },
      { seasonId: 'sea_a' },
      { gameId: 'gam_2' },
      { teamId: 'tem_nobody' }
    ])
    expect(
      statements.filter(each =>
        each.startsWith('insert into "notification_events"')
      )
    ).lengthOf(1)
    expect(tallies.get('tem_b')?.removed).equals(2)
  })
})

describe('a season’s game consent', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('reads a season’s active teams once inside withRolesRead, for every pair', async () => {
    mock.method(rights, 'canAdminister', async () => true)
    let reads = 0
    await withQueryReplies(
      query => {
        expect(query.sql).includes('from "season_teams"')
        reads++
        return [
          { team_id: 'tem_a' },
          { team_id: 'tem_b' },
          { team_id: 'tem_c' }
        ]
      },
      async db => {
        const game = (home: string, away: string): GameProposal['game'] => ({
          ...body(1).game,
          homeTeamId: home,
          awayTeamId: away
        })
        await withRolesRead(db, async () => {
          expect(
            await seasonGameConsent(db, actor, game('tem_a', 'tem_b'))
          ).equals(true)
          expect(
            await seasonGameConsent(db, actor, game('tem_a', 'tem_c'))
          ).equals(true)
          expect(
            await seasonGameConsent(db, actor, game('tem_a', 'tem_left'))
          ).equals(false)
        })
        expect(reads).equals(1)
        expect(
          await seasonGameConsent(db, actor, game('tem_a', 'tem_a'))
        ).equals(false)
        // An open side needs no consent; each named side must be a member.
        const open = (
          home: string | null,
          away: string | null
        ): GameProposal['game'] => ({
          ...body(1).game,
          homeTeamId: home,
          awayTeamId: away
        })
        expect(await seasonGameConsent(db, actor, open('tem_a', null))).equals(
          true
        )
        expect(await seasonGameConsent(db, actor, open(null, null))).equals(
          true
        )
        expect(
          await seasonGameConsent(db, actor, open(null, 'tem_left'))
        ).equals(false)
        expect(
          await seasonGameConsent(db, actor, {
            ...game('tem_a', 'tem_b'),
            seasonId: null
          })
        ).equals(false)
      }
    )
  })
})

describe('the names a game request freezes', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('freezes its season’s zone for a game sent without one, read once inside withRolesRead', async () => {
    const reads: string[] = []
    await withQueryReplies(
      query => {
        reads.push(query.sql)
        if (query.sql.startsWith('select "timezone" from "seasons"'))
          return [{ timezone: 'America/Chicago' }]
        if (query.sql.startsWith('select "name" from'))
          return [{ name: `Name of ${String(query.parameters[0])}` }]
        throw new Error(query.sql)
      },
      async db => {
        const game = { ...body(1).game, timezone: undefined }
        const request = {
          kind: 'game',
          terms: { kind: 'game', game, gameId: null, previous: null }
        } as unknown as Parameters<typeof frozenNamesOf>[1]
        await withRolesRead(db, async () => {
          const frozen = await frozenNamesOf(db, request)
          expect(frozen.zones).deep.equals({ sea_a: 'America/Chicago' })
          await frozenNamesOf(db, request)
        })
        expect(reads.filter(sql => sql.includes('"timezone"'))).lengthOf(1)
        // A season gone reads as UTC.
        await withQueryReplies(
          () => [],
          async gone => {
            expect((await frozenNamesOf(gone, request)).zones).deep.equals({
              sea_a: 'UTC'
            })
          }
        )
      }
    )
  })
})
