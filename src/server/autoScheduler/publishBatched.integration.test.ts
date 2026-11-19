import { expect } from 'chai'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { HttpError } from '../../common/errors'
import { makeId } from '../../common/ids'
import {
  editedGames,
  type SchedulePreview
} from '../../common/schedulePreviews'
import { buildSchedule, engineResult } from '../../common/scheduler/engine'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import {
  createMigratedDatabase,
  dropScratchDatabase,
  testDatabaseUrl,
  testDatabaseUrlOf
} from '../../migrate/testDatabase'
import { G1, SEASON_TIMEZONE } from '../../test/autoSchedulerFixture'
import { type SchedulerWorld, schedulerWorld } from '../../test/schedulerWorld'
import type { Actor } from '../auth/sessions'
import { atomic } from '../db/atomic'
import { type Database, makePool } from '../db/database'
import { makeNonce } from '../dev/fixtures/accounts'
import { NODE_SETTINGS } from '../dev/fixtures/nodeSettings'
import { runPackedLeague } from '../dev/fixtures/packedLeague'
import { proposeGame } from '../schedule/gameApprovals'
import { createTeam } from '../teams/createTeam'
import { insertUser } from '../users/insertUser'
import type { Tallies } from './cancel'
import {
  completePreview,
  editsOf,
  optionsOf,
  preparePreview,
  type PreviewRow,
  snapshotOf
} from './previews'
import { proposePlanned } from './propose'
import { publishPreview } from './publish'

/**
 * The batched publication against the one that proposes each game alone
 * (`oneByOne`): one preview built once, its database copied, each copy
 * published one way, and everything a publication writes or announces
 * compared, the ids it makes named by what they are for.
 */

type Db = Kysely<Database>

/** The tables a publication writes. */
const TABLES = [
  'group_requests',
  'group_request_sides',
  'games',
  'schedule_previews',
  'schedule_preview_games',
  'creation_idempotency',
  'game_field_warnings',
  'notification_events',
  'umpire_assignments'
] as const

/** The channels a publication's changes are announced on. */
const CHANNELS = ['game_changes', 'screen_scopes', 'live_changes']

/** Heard by a listener once everything announced before it has arrived. */
const SETTLED = 'publish_differential_settled'

/** Columns a statement fills from its own clock, not the caller's. */
const STAMPS = new Set(['created_at', 'updated_at', 'notified_at'])

function open(name: string): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: makePool(testDatabaseUrlOf(name)) })
  })
}

/** A copy of `from`, after closing every other connection to it. */
async function copyDatabase(
  admin: Pool,
  from: string,
  to: string
): Promise<void> {
  // A harness pool reconnects on its next query; it logs the lost ones.
  const log = console.error
  console.error = (...args: unknown[]) => {
    if (!String(args[0]).startsWith('database: connection lost')) log(...args)
  }
  try {
    for (let attempt = 0; ; attempt++) {
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [from]
      )
      try {
        await admin.query(`create database "${to}" template "${from}"`)
        break
      } catch (error) {
        if (attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  } finally {
    console.error = log
  }
}

/** What a database announced, in the order it arrived. */
interface Listener {
  heard: Array<{ channel: string; payload: string }>
  /** Waits for everything announced so far, and stops listening. */
  settle: (db: Db) => Promise<void>
}

async function listen(name: string): Promise<Listener> {
  const client = new Client({ connectionString: testDatabaseUrlOf(name) })
  await client.connect()
  const heard: Listener['heard'] = []
  let settled: (() => void) | undefined
  client.on('notification', message => {
    if (message.channel === SETTLED) settled?.()
    else
      heard.push({ channel: message.channel, payload: message.payload ?? '' })
  })
  for (const channel of [...CHANNELS, SETTLED])
    await client.query(`listen ${channel}`)
  return {
    heard,
    settle: async db => {
      const done = new Promise<void>(resolve => {
        settled = resolve
      })
      await sql`select pg_notify(${SETTLED}, '')`.execute(db)
      await done
      await client.end()
    }
  }
}

type Rows = Record<string, Array<Record<string, unknown>>>

async function dump(db: Db): Promise<Rows> {
  const rows: Rows = {}
  for (const table of TABLES)
    rows[table] = (
      await sql<
        Record<string, unknown>
      >`select * from ${sql.table(table)}`.execute(db)
    ).rows
  return rows
}

/** Every id in the database before the publication. */
function idsIn(rows: Rows): Set<string> {
  return new Set(
    ['group_requests', 'games', 'notification_events'].flatMap(table =>
      rows[table].map(row => String(row.id))
    )
  )
}

/** One publication's outcome, its new ids named and its own stamps blank. */
interface Outcome {
  rows: Record<string, string[]>
  heard: string[]
  answer: string
}

function outcome(
  rows: Rows,
  known: Set<string>,
  heard: Listener['heard'],
  answer: unknown,
  since: Date
): Outcome {
  const names = new Map<string, string>()
  const fresh = rows.group_requests.filter(row => !known.has(String(row.id)))
  for (const request of fresh) {
    const held = rows.creation_idempotency.find(
      row => (row.response as { id: string }).id === request.id
    )
    expect(held, `request ${String(request.id)} is a proposal`).not.equal(
      undefined
    )
    const key = String(held!.key)
    names.set(String(request.id), `<request ${key}>`)
    const proposed = (request.terms as { proposedGameId?: string })
      .proposedGameId
    if (proposed != null && !known.has(proposed))
      names.set(proposed, `<game ${key}>`)
  }
  for (const game of rows.games)
    if (!known.has(String(game.id)))
      expect(names.has(String(game.id)), `game ${String(game.id)}`).equals(true)
  for (const event of rows.notification_events)
    if (!known.has(String(event.id))) names.set(String(event.id), '<audit>')
  const pattern =
    names.size === 0
      ? undefined
      : new RegExp(
          [...names.keys()]
            .sort((a, b) => b.length - a.length)
            .map(id => id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'))
            .join('|'),
          'g'
        )
  const named = (text: string): string =>
    pattern == null ? text : text.replace(pattern, id => names.get(id)!)
  const stamped = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(row).map(([column, value]) => [
        column,
        STAMPS.has(column) &&
        value instanceof Date &&
        value.getTime() >= since.getTime()
          ? '<stamp>'
          : value
      ])
    )
  return {
    rows: Object.fromEntries(
      Object.entries(rows).map(([table, list]) => [
        table,
        list.map(row => named(JSON.stringify(stamped(row)))).sort()
      ])
    ),
    heard: heard.map(each => named(`${each.channel} ${each.payload}`)),
    answer: named(JSON.stringify(answer))
  }
}

/** Two copies of one database: `perGame` and `batched`. */
interface Copies {
  perGame: string
  batched: string
}

async function publishBoth(
  copies: Copies,
  publish: (db: Db, oneByOne: boolean) => Promise<unknown>
): Promise<{ perGame: Outcome; batched: Outcome }> {
  const run = async (name: string, oneByOne: boolean): Promise<Outcome> => {
    const db = open(name)
    try {
      const before = await dump(db)
      const known = idsIn(before)
      const since = new Date()
      const listener = await listen(name)
      let answer: unknown
      try {
        answer = await publish(db, oneByOne)
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        answer = {
          refused: error.status,
          code: error.code,
          message: error.message,
          details: error.details
        }
      }
      await listener.settle(db)
      return outcome(await dump(db), known, listener.heard, answer, since)
    } finally {
      await db.destroy()
    }
  }
  return {
    perGame: await run(copies.perGame, true),
    batched: await run(copies.batched, false)
  }
}

/** The two outcomes are alike, table by table, then what was announced. */
function expectAlike(both: { perGame: Outcome; batched: Outcome }): void {
  for (const table of TABLES)
    expect(both.batched.rows[table], table).deep.equals(
      both.perGame.rows[table]
    )
  expect(both.batched.heard, 'announced').deep.equals(both.perGame.heard)
  expect(both.batched.answer, 'answer').equals(both.perGame.answer)
  const counts = TABLES.map(
    table => `${table} ${both.batched.rows[table].length}`
  ).join(', ')
  console.log(
    `      alike: ${counts}; ${both.batched.heard.length} announcements`
  )
}

describe('a batched publication against one game at a time', function () {
  this.timeout(600000)
  let admin: Pool
  const scratch: string[] = []
  const name = (label: string): string => {
    const each = `teamstation_publish_${label}_${process.pid}_${Date.now()}`
    scratch.push(each)
    return each
  }
  before(() => {
    admin = new Pool({ connectionString: testDatabaseUrl })
  })
  after(async () => {
    for (const each of scratch) await dropScratchDatabase(admin, each)
    await admin.end()
  })

  it('writes and announces the same for the packed league, 338 games all scheduled, and answers a repeat the same', async () => {
    const original = name('packed')
    await createMigratedDatabase(admin, original, migrations)
    const db = open(original)
    const clock = { now: () => new Date('2026-11-16T08:00:00Z') }
    let actor: Actor
    let previewId: string
    try {
      for (const [key, value] of Object.entries(NODE_SETTINGS))
        await db
          .insertInto('system_settings')
          .values({ key, value: value as never })
          .onConflict(oc =>
            oc.column('key').doUpdateSet({ value: value as never })
          )
          .execute()
      const m = await runPackedLeague({
        db,
        mailbox: 'testmailbox@example.test',
        nonce: makeNonce()
      })
      actor = { userId: m.accounts.admin.userId, isAdmin: false, scopes: [] }
      const prepared = await preparePreview(
        db,
        actor,
        m.ids.league,
        { mode: 'full' },
        clock
      )
      const result = engineResult(
        await buildSchedule({ input: prepared.input })
      )
      expect(result.options[0].games).lengthOf(338)
      await completePreview(db, actor, prepared.id, result, clock)
      previewId = prepared.id
    } finally {
      await db.destroy()
    }
    const copy = name('packed_copy')
    await copyDatabase(admin, original, copy)
    const both = await publishBoth(
      { perGame: original, batched: copy },
      async (db, oneByOne) => {
        const first = await publishPreview(db, actor, previewId, 0, clock, {
          oneByOne
        })
        expect(first.scheduled).equals(338)
        const again = await publishPreview(db, actor, previewId, 0, clock, {
          oneByOne
        })
        expect(again).deep.equals(first)
        return first
      }
    )
    expectAlike(both)
  })

  describe('in the scheduler world', () => {
    let w: SchedulerWorld | undefined
    afterEach(async () => {
      await w?.close()
      w = undefined
    })
    const actor = {
      userId: userIdOfGumbo(101),
      isAdmin: false,
      scopes: []
    }
    const build = async (body: unknown): Promise<SchedulePreview> => {
      const built = await w!.call<SchedulePreview>(
        101,
        'POST',
        `/leagues/${w!.fx.f.leagueA}/schedule-previews/preparations`,
        body
      )
      expect(built.status).equals(201)
      return built.body
    }
    /** The world's database and a copy of it. */
    const copied = async (label: string): Promise<Copies> => {
      const original = String(
        (
          await sql<{
            name: string
          }>`select current_database() as name`.execute(w!.fx.f.h.db)
        ).rows[0].name
      )
      const copy = name(label)
      await copyDatabase(admin, original, copy)
      return { perGame: original, batched: copy }
    }
    const publisher =
      (previewId: string, clock: { now: () => Date }) =>
      async (db: Db, oneByOne: boolean) =>
        await publishPreview(db, actor, previewId, 0, clock, { oneByOne })

    it('writes the same when some games wait for a team’s approval, with placeholder teams, exhibitions and an umpire', async () => {
      w = await schedulerWorld()
      const { f, teams } = w.fx
      // Two placeholder teams: one kept by the season, one by a team.
      for (const [id, custodian] of [
        ['tem_differentialSeasonStub', { type: 'season', id: f.seasonA }],
        ['tem_differentialTeamStub', { type: 'team', id: teams.Owls }]
      ] as const) {
        await f.h.db
          .insertInto('teams')
          .values({
            id,
            name: `Demo ${id.slice(4)}`,
            kind: 'external',
            custodian_type: custodian.type,
            custodian_id: custodian.id
          })
          .execute()
        await f.h.db
          .insertInto('season_teams')
          .values({ season_id: f.seasonA, team_id: id, active: true })
          .execute()
      }
      await f.h.db
        .insertInto('umpire_assignments')
        .values({
          game_id: G1,
          slot: 'plate:1',
          user_id: userIdOfGumbo(101),
          assigned_by: userIdOfGumbo(101),
          credit_team_id: null
        })
        .execute()
      const built = await build({ mode: 'full', existing: 'workAround' })
      // Field 1 closes on the first game's day after the build, which the
      // build's own rules do not see: that game is published with a
      // warning, told to both teams.
      const first = [...built.options[0].games]
        .filter(game => game.fieldId === w!.fieldId)
        .sort((a, b) => a.startAt.localeCompare(b.startAt))[0]
      await f.h.db
        .updateTable('venue_fields')
        .set({
          blackouts: [
            new Intl.DateTimeFormat('en-CA', {
              timeZone: SEASON_TIMEZONE
            }).format(new Date(first.startAt))
          ]
        })
        .where('id', '=', w.fieldId)
        .execute()
      // The Visitors stop competing after the build, so their games need
      // their admin's approval.
      await f.h.db
        .updateTable('season_teams')
        .set({ active: false })
        .where('season_id', '=', f.seasonA)
        .where('team_id', '=', teams.Visitors)
        .execute()
      // Umpires assigned to games outside the league at the times of the
      // first two published games: one plays for each published game's home
      // team, so publishing it takes his assignment away, and one plays for
      // nobody, so hers stays.
      const overlapped = [...built.options[0].games]
        .filter(
          game =>
            game.homeTeamId !== teams.Visitors &&
            game.awayTeamId !== teams.Visitors
        )
        .sort((a, b) => a.startAt.localeCompare(b.startAt))
        .slice(0, 2)
      expect(overlapped).lengthOf(2)
      const outside = async (name: string): Promise<string> =>
        (
          await createTeam(
            f.h.db,
            { name: `Demo Umpire ${name}`, externalIds: [] },
            { userId: actor.userId, isAdmin: false }
          )
        ).id
      const umpire = async (name: string): Promise<string> =>
        await insertUser(f.h.db, {
          display_name: `Demo Umpire ${name}`,
          first_name: 'Demo',
          last_name: `Umpire ${name}`
        })
      const free = await umpire('Free')
      const playing: string[] = []
      for (const [i, game] of overlapped.entries()) {
        const id = `gam_differentialUmpire${i}`
        await f.h.db
          .insertInto('games')
          .values({
            id,
            home_team_id: await outside(`Home ${i}`),
            away_team_id: await outside(`Away ${i}`),
            season_id: null,
            start_at: new Date(game.startAt),
            end_at: new Date(game.endAt),
            timezone: SEASON_TIMEZONE,
            venue: 'Demo Umpire Park',
            status: 'scheduled'
          })
          .execute()
        const player = await umpire(`Playing ${i}`)
        playing.push(player)
        await f.h.db
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            user_id: player,
            team_id: game.homeTeamId,
            role: 'member',
            is_player: true,
            jersey: null,
            joined_at: new Date(),
            granted_by_link_id: null
          })
          .execute()
        for (const [slot, user] of [
          ['plate:1', player],
          ['base:1', free]
        ] as const)
          await f.h.db
            .insertInto('umpire_assignments')
            .values({
              game_id: id,
              slot,
              user_id: user,
              assigned_by: actor.userId,
              credit_team_id: null
            })
            .execute()
      }
      const at = new Date()
      const both = await publishBoth(
        await copied('awaiting'),
        async (db, oneByOne) => {
          const published = await publisher(built.id, { now: () => at })(
            db,
            oneByOne
          )
          expect(published.awaiting).greaterThan(0)
          expect(published.scheduled).greaterThan(0)
          return published
        }
      )
      expectAlike(both)
      expect(both.batched.rows.games.join('\n')).includes(
        'tem_differentialSeasonStub'
      )
      expect(both.batched.rows.game_field_warnings.join('\n')).includes(
        'outsideAvailability'
      )
      expect(both.batched.rows.notification_events.join('\n')).includes(
        'fieldWarning'
      )
      // Each playing umpire's assignment was taken away; G1's and the free
      // umpire's stay.
      const assigned = both.batched.rows.umpire_assignments.join('\n')
      for (const player of playing) expect(assigned).not.includes(player)
      expect(both.batched.rows.umpire_assignments).lengthOf(3)
      expect(assigned).includes(free)
    })

    it('writes the same when it replaces the league’s upcoming games', async () => {
      w = await schedulerWorld()
      const built = await build({ mode: 'full', existing: 'replace' })
      const at = new Date()
      const both = await publishBoth(
        await copied('replace'),
        async (db, oneByOne) => {
          const published = await publisher(built.id, { now: () => at })(
            db,
            oneByOne
          )
          expect(published.removed).equals(2)
          return published
        }
      )
      expectAlike(both)
    })

    it('refuses alike, writing nothing, when a team was merged since the build', async () => {
      w = await schedulerWorld()
      const built = await build({ mode: 'full', existing: 'workAround' })
      await w.fx.f.h.db
        .updateTable('teams')
        .set({ merged_into: w.fx.teams.Hawks })
        .where('id', '=', w.fx.teams.Owls)
        .execute()
      const at = new Date()
      const both = await publishBoth(
        await copied('refused'),
        publisher(built.id, { now: () => at })
      )
      expectAlike(both)
      expect(both.batched.answer).includes('"refused":409')
      expect(both.batched.heard).deep.equals([])
    })

    it('skips the games already proposed and replays a proposal sent before, alike', async () => {
      w = await schedulerWorld()
      const built = await build({ mode: 'full', existing: 'workAround' })
      const db = w.fx.f.h.db
      const row: PreviewRow = await db
        .selectFrom('schedule_previews')
        .selectAll()
        .where('id', '=', built.id)
        .executeTakeFirstOrThrow()
      const snap = snapshotOf(row)
      const games = editedGames(optionsOf(row)[0], editsOf(row), 0)
      const at = new Date()
      const clock = { now: () => at }
      // Two games proposed by an earlier attempt, and one more whose
      // proposal was sent but never recorded on the preview.
      await atomic(db, async trx => {
        await proposePlanned(
          trx,
          actor,
          row.id,
          snap,
          games.slice(0, 2),
          clock,
          new Map()
        )
      })
      const third = games[2]
      await proposeGame(
        db,
        actor,
        {
          sender: { kind: 'season', id: third.seasonId },
          game: {
            homeTeamId: third.homeTeamId,
            awayTeamId: third.awayTeamId,
            seasonId: third.seasonId,
            startAt: third.startAt,
            endAt: third.endAt,
            timezone:
              snap.engine.fields.find(field => field.id === third.fieldId)
                ?.availability.timezone ?? 'UTC',
            venue: null,
            outsideTournament: null,
            status: 'scheduled',
            exhibition: third.exhibition,
            fieldId: third.fieldId,
            fieldSize: third.size
          },
          idempotencyKey: `schedule:${row.id}:${third.key}`
        },
        clock,
        undefined,
        { schedulePreviewId: row.id }
      )
      const both = await publishBoth(
        await copied('retry'),
        async (db, oneByOne) => {
          const tallies: Tallies = new Map()
          await atomic(db, async trx => {
            await proposePlanned(
              trx,
              actor,
              row.id,
              snap,
              games,
              clock,
              tallies,
              {
                oneByOne
              }
            )
          })
          return [...tallies].map(([teamId, counts]) => [
            teamId,
            { ...counts, seasonIds: [...counts.seasonIds] }
          ])
        }
      )
      expectAlike(both)
    })
  })
})
