import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { DELETED_NAME } from '../account/deleteAccount'
import { createSession } from '../auth/sessions'
import { type Database, makeDatabase } from '../db/database'
import {
  createNamesFixture,
  NAMES_PEOPLE,
  type NamesFixture
} from '../dev/namesFixture'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { narrationsFor } from '../replay/narrationAudio'
import { accountRoutes } from '../routes/account'
import { eventRoutes } from '../routes/events'
import { lineupRoutes } from '../routes/lineups'
import { notificationRoutes } from '../routes/notifications'
import { playerRoutes } from '../routes/players'
import { teamRoutes } from '../routes/teams'
import { boardTimeline } from '../scoreboard/boardTimeline'

/**
 * A person's name lives in `users` alone. On the names fixture (a game scored
 * through a session with substitutions, a steal and a wild pitch, a game-only
 * player who pinch-hits; an outside scorer's game with a typed opponent and a
 * `to` fielding chain; a video with highlights; a default lineup; a guardian
 * request and a coach grant) a rename and an account deletion change every
 * surface that names a player: the game's plays, highlights, the player page,
 * lineups and DJ, the default lineup, the scoreboard timeline, narration and
 * the inbox. The stored rows of `events`, `games`, `"eventCredits"`, `teams`
 * and `notification_events` never change, and hold no name but the typed
 * opponent's.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_derived_names_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

/** The tables that hold game documents, credits, lineups and notifications. */
const STORED = [
  'events',
  'games',
  'eventCredits',
  'teams',
  'notification_events'
] as const

type Role = keyof NamesFixture['people']

interface Answer {
  status: number
  body: any
}

/**
 * `value` with every `firstName` and `lastName` left out (the halves a
 * scorer gets are checked on their own), and every still's URL, which is
 * signed afresh each second.
 */
function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable)
  if (value == null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          key !== 'firstName' && key !== 'lastName' && key !== 'stillUrl'
      )
      .map(([key, inner]) => [key, comparable(inner)])
  )
}

/** `value` read with each short name `from` as `to`, and nothing else. */
function renamed(value: unknown, names: Array<[string, string]>): unknown {
  let text = JSON.stringify(value)
  for (const [from, to] of names) text = text.split(from).join(to)
  return JSON.parse(text)
}

describe('names derived from accounts', function () {
  this.timeout(120000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  let f: NamesFixture
  const tokens = new Map<Role, string>()
  /** The stored rows before anything was renamed. */
  let stored: Record<string, string[]>
  /** Every surface before the renames, and after them. */
  let first: Record<string, unknown>
  let second: Record<string, unknown>
  let firstVersion: string

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    try {
      await migrateUp(pool, migrations)
    } finally {
      await pool.end()
    }
    db = makeDatabase(scratchUrl)
    f = await createNamesFixture(db, { stamp: 'derived' })
    for (const role of Object.keys(f.people) as Role[])
      tokens.set(
        role,
        (await createSession(db, f.people[role].userId, 'derived-names')).token
      )
    // No file and no Space: nothing here reads or writes media.
    const media: MediaContext = {
      mediaRoot: mkdtempSync(join(tmpdir(), 'tsDerivedNames-')),
      ffmpegPath: 'ffmpeg',
      mediaSecret: 'secret',
      publicUrl: 'http://127.0.0.1',
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        pathStyle: true
      }
    }
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', eventRoutes(db))
    app.use('/api/v1', lineupRoutes(db))
    app.use('/api/v1', playerRoutes(db, media))
    app.use('/api/v1', teamRoutes(db, media))
    app.use('/api/v1', notificationRoutes(db))
    app.use(
      '/api/v1',
      accountRoutes(db, {
        ffmpegPath: media.ffmpegPath,
        space: media.space,
        sendCode: async () => undefined,
        publicUrl: 'http://127.0.0.1'
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    const listening = server
    if (listening != null)
      await new Promise(resolve => listening.close(resolve))
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  async function call(
    role: Role,
    method: string,
    path: string,
    body?: unknown
  ): Promise<Answer> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens.get(role)}`,
        ...(body == null ? {} : { 'content-type': 'application/json' })
      },
      body: body == null ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text)
    }
  }

  async function read(role: Role, path: string): Promise<unknown> {
    const answer = await call(role, 'GET', path)
    expect(answer.status, path).equals(200)
    return answer.body
  }

  const soto = (): NamesFixture['players']['away'][number] => f.players.away[0]
  const freeman = (): NamesFixture['players']['home'][number] =>
    f.players.home[1]

  /** An events answer, without what only names the roster as it is now. */
  const withoutModelNames = (answer: unknown): unknown => {
    const { modelNames: _modelNames, ...rest } = answer as Record<
      string,
      unknown
    >
    return rest
  }

  /**
   * Every surface that names the game's players, read by the visitors'
   * second administrator.
   */
  async function surfaces(): Promise<Record<string, unknown>> {
    const rizzo = f.people.deletable.userId
    const timeline = await boardTimeline(db!, f.gameId)
    return comparable({
      events: withoutModelNames(
        await read('secondAdmin', `/games/${f.gameId}/events`)
      ),
      outsideEvents: withoutModelNames(
        await read('secondAdmin', `/games/${f.outsideGameId}/events`)
      ),
      highlights: await read('secondAdmin', `/videos/${f.videoId}/highlights`),
      sotoPage: await read('secondAdmin', `/players/${soto().userId}`),
      sotoHighlights: await read(
        'secondAdmin',
        `/players/${soto().userId}/highlights`
      ),
      rizzoHighlights: await read(
        'secondAdmin',
        `/players/${rizzo}/highlights`
      ),
      lineups: await read('secondAdmin', `/games/${f.gameId}/lineups`),
      dj: await read('secondAdmin', `/games/${f.gameId}/dj`),
      defaultLineup: await read(
        'secondAdmin',
        `/teams/${f.teams.away}/default-lineup`
      ),
      timeline: timeline?.steps,
      narration: Object.fromEntries(await narrationsFor(db!, f.gameId))
    }) as Record<string, unknown>
  }

  async function timelineVersion(): Promise<string> {
    return (await boardTimeline(db!, f.gameId))!.version
  }

  /** The test account's inbox titles: pending, then history. */
  async function inboxTitles(): Promise<{
    pending: string[]
    history: string[]
  }> {
    const titles = async (path: string): Promise<string[]> =>
      (
        (await read('testAccount', path)) as { items: Array<{ title: string }> }
      ).items.map(item => item.title)
    return {
      pending: await titles('/me/notifications'),
      history: await titles('/me/notifications?history=1')
    }
  }

  /** Every stored row of the tables that must never change, as text. */
  async function storedRows(): Promise<Record<string, string[]>> {
    const rows: Record<string, string[]> = {}
    for (const table of STORED)
      rows[table] = (
        await sql<{ row: string }>`select row_to_json(t)::text as row
          from ${sql.table(table)} t order by t.id::text`.execute(db!)
      ).rows.map(row => row.row)
    return rows
  }

  /**
   * How many stored rows of those tables hold a word that is a person's
   * name: a first, last or display name of four letters or more of any
   * account, under any name it has had.
   */
  async function storedNameCount(names: string[]): Promise<number> {
    const words = [
      ...new Set(
        names
          .flatMap(name => [name, ...name.split(' ')])
          .filter(word => word.length >= 4)
      )
    ]
    const pattern = `\\m(${words
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})\\M`
    let count = 0
    for (const table of STORED)
      count += Number(
        (
          await sql<{
            n: string
          }>`select count(*) as n from ${sql.table(table)} t
            where row_to_json(t)::text ~ ${pattern}`.execute(db!)
        ).rows[0].n
      )
    return count
  }

  /**
   * Every name the accounts hold now (display, first and last), added to
   * the names they held before: the typed opponent has no account.
   */
  const everyName = new Set<string>()
  async function accountNames(): Promise<string[]> {
    const rows = await db!
      .selectFrom('users')
      .select(['display_name', 'first_name', 'last_name'])
      .execute()
    for (const row of rows)
      for (const name of [row.display_name, row.first_name, row.last_name])
        if (name != null) everyName.add(name)
    return [...everyName]
  }

  it('names every surface from the accounts, and stores no name', async function () {
    stored = await storedRows()
    first = await surfaces()
    firstVersion = await timelineVersion()
    const events = first.events as {
      plays: Array<{
        gumbo: {
          matchup: { batter: { fullName: string } }
          playEvents?: Array<{ details: { description?: string } }>
          credits?: Array<{ label: string }>
        }
      }>
    }
    expect(events.plays[0].gumbo.matchup.batter.fullName).equals('Juan S')
    const sentences = events.plays.flatMap(play =>
      (play.gumbo.playEvents ?? []).map(event => event.details.description)
    )
    expect(sentences).includes('Juan S steals second.')
    expect(sentences).includes(
      'Offensive Substitution: Pinch-hitter Ichiro S replaces Anthony R.'
    )
    expect(
      events.plays.flatMap(play =>
        (play.gumbo.credits ?? []).map(credit => credit.label)
      )
    ).includes('Single: Anthony R')
    const outside = first.outsideEvents as typeof events
    expect(
      outside.plays.map(play => play.gumbo.credits?.map(c => c.label))
    ).deep.equals([
      [`Single: ${NAMES_PEOPLE.typedOpponent}`],
      ['Ground out: Mookie B (SS) to Freddie F (1B)']
    ])
    const titles = (
      first.highlights as { highlights: Array<{ title: string }> }
    ).highlights.map(h => h.title)
    expect(titles.slice(0, 3)).deep.equals([
      'Walk: Juan S',
      'Strikeout: Tyler G',
      'Single: Anthony R · Stolen base: Juan S'
    ])
    expect((first.sotoPage as { name: string }).name).equals('Juan S')
    expect(
      (first.dj as { away: { batters: Array<{ name: string }> } }).away
        .batters[0].name
    ).equals('Juan S')
    expect(
      (
        first.defaultLineup as {
          lineup: { batters: Array<{ name: string }> }
        }
      ).lineup.batters
        .slice(0, 3)
        .map(b => b.name)
    ).deep.equals(['Juan S', 'Aaron J', 'Anthony R'])
    expect(
      (first.timeline as Array<{ state: { batterName: string } }>).some(
        step => step.state.batterName === 'Ichiro S'
      )
    ).equals(true)
    expect(Object.values(first.narration as object).map(n => n.text)).includes(
      'Ball four, Juan S walks.'
    )
    expect(await inboxTitles()).deep.equals({
      pending: ["Joe Torre asks to be Mike T's guardian"],
      history: ['Bobby Cox added you as Coach of Lakeside Owls']
    })
    expect(await storedNameCount(await accountNames())).equals(0)
    // The typed opponent has no account: his typed name is all there is.
    expect(await storedNameCount([NAMES_PEOPLE.typedOpponent])).greaterThan(0)
  })

  it('reads a rename on every surface, writing nothing but the account', async function () {
    // A team administrator renames the visitors' leadoff hitter.
    const leadoff = await call(
      'secondAdmin',
      'PUT',
      `/teams/${f.teams.away}/players/${soto().userId}/settings`,
      { name: { firstName: 'Vladimir', lastName: 'Guerrero' } }
    )
    expect(leadoff.status).equals(200)
    expect(leadoff.body.shortName).equals('Vladimir G')
    // A home fielder of the outside scorer's chain is renamed as a roster
    // import renames him: in his account alone.
    await db!
      .updateTable('users')
      .set({
        first_name: 'Joey',
        last_name: 'Votto',
        display_name: 'Joey Votto'
      })
      .where('id', '=', freeman().userId)
      .execute()
    // The scorer's roster editor corrects the game-only player.
    const guest = await call(
      'admin',
      'PUT',
      `/games/${f.gameId}/guest-players/${f.guest.userId}`,
      { firstName: 'Hideki', lastName: 'Matsui' }
    )
    expect(guest.status).equals(200)
    // The request's sender and the grant's actor rename themselves.
    for (const [role, displayName] of [
      ['admin', 'Tony La Russa'],
      ['secondAdmin', 'Earl Weaver']
    ] as const)
      expect(
        (await call(role, 'PUT', '/me/account/name', { displayName })).status
      ).equals(200)

    second = await surfaces()
    expect(second).deep.equals(
      renamed(first, [
        ['Juan S', 'Vladimir G'],
        ['Freddie F', 'Joey V'],
        ['Ichiro S', 'Hideki M']
      ])
    )
    expect(await timelineVersion()).not.equals(firstVersion)
    expect(await inboxTitles()).deep.equals({
      pending: ["Tony La Russa asks to be Mike T's guardian"],
      history: ['Earl Weaver added you as Coach of Lakeside Owls']
    })
    // A scorer reads the corrected guest's halves.
    const events = (await read('admin', `/games/${f.gameId}/events`)) as {
      plays: Array<{
        gumbo: {
          teamStation?: {
            setupBefore?: {
              players: Record<string, { firstName?: string; lastName?: string }>
            }
          }
        }
      }>
    }
    const last = events.plays.at(-1)!.gumbo.teamStation!.setupBefore!.players
    expect(last[String(f.guest.gumboId)]).include({
      firstName: 'Hideki',
      lastName: 'Matsui'
    })

    expect(await storedRows()).deep.equals(stored)
    expect(await storedNameCount(await accountNames())).equals(0)
  })

  it('reads a deleted account as "Deleted user" on every surface, writing nothing but the account', async function () {
    const version = await timelineVersion()
    // A player of the game deletes his account, and so does the request's
    // sender, whom another administrator of the team stands in for.
    expect((await call('deletable', 'DELETE', '/me/account')).status).equals(
      204
    )
    expect((await call('admin', 'DELETE', '/me/account')).status).equals(204)
    const accounts = await db!
      .selectFrom('users')
      .select(['display_name', 'deleted_at'])
      .where('id', 'in', [f.people.deletable.userId, f.people.admin.userId])
      .execute()
    for (const account of accounts) {
      expect(account.display_name).equals(DELETED_NAME)
      expect(account.deleted_at).not.equals(null)
    }

    expect(await surfaces()).deep.equals(
      renamed(second, [['Anthony R', DELETED_NAME]])
    )
    expect(await timelineVersion()).not.equals(version)
    // The request ended with its sender's account, and still reads.
    expect(await inboxTitles()).deep.equals({
      pending: [],
      history: [
        `${DELETED_NAME} asks to be Mike T's guardian`,
        'Earl Weaver added you as Coach of Lakeside Owls'
      ]
    })

    expect(await storedRows()).deep.equals(stored)
    expect(await storedNameCount(await accountNames())).equals(0)
  })
})
