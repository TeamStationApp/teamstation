import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import type { ScoringAction } from '../../common/scoring/actions'
import { mapPlayers } from '../../common/scoring/actions'
import { replayPlays } from '../../common/scoring/gumbo'
import { withNames } from '../../common/scoring/storedNames'
import { recordBySide } from '../../common/scoring/teamRecord'
import { userIdOfGumbo } from '../../common/userId'
import type { Database } from '../../server/db/database'
import { makeDatabase } from '../../server/db/database'
import { atBatOf } from '../../server/events/atBatInProgress'
import { lineupsBefore } from '../../server/events/postPlays'
import { resolveScoringGame } from '../../server/scoring/openRow'
import { gameNames } from '../../server/users/nameBook'
import {
  AWAY_PLAYERS,
  HOME_PLAYERS,
  REPLAY_TEAMS,
  replayActions,
  replayContext,
  scored
} from '../../test/replayGameFixture'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migrations } from './index'

type Json = Record<string, unknown>

const before092 = migrations.filter(m => m.name < '092')
const through092 = migrations.filter(m => m.name <= '092playerNamesFromUsers')

const SIDES = {
  away: { id: REPLAY_TEAMS.away.id },
  home: { id: REPLAY_TEAMS.home.id }
}

/** Guests a scorer added in the game, found on no roster. */
const WITT = 9301
const SEAGER = 9302
const GUESTS = [
  { gumboId: WITT, first: 'Bobby', last: 'Witt' },
  { gumboId: SEAGER, first: 'Corey', last: 'Seager' }
]
const PEOPLE = [...AWAY_PLAYERS, ...HOME_PLAYERS, ...GUESTS]
const STANTON = 9110
const BADER = 9108
const BETTS = 9201
const FREEMAN = 9202

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** A document as it was stored before sentences carried `said`. */
function withoutSaid<T>(document: T): T {
  return JSON.parse(
    JSON.stringify(document, (key, value: unknown) =>
      key === 'said' ? undefined : value
    )
  ) as T
}

/** A play's record as an app built it before records were kept by team. */
function bySide<T>(document: T): T {
  const play = document as Json | null
  if (play?.teamStation == null) return document
  const next: Json = {
    ...play,
    teamStation: recordBySide(play.teamStation, SIDES)
  }
  return next as T
}

/**
 * A version 2 record as version 1 kept it: its players keyed by session id,
 * each with his gumbo id as `userId`, every action naming them by session id,
 * and an `addPlayer` action naming no player, its guest the next session id.
 */
function asVersion1(raw: Json, sessionOf: Map<number, number>): Json {
  const sid = (value: unknown): number => {
    const id = sessionOf.get(value as number)
    if (id == null) throw new Error(`No session id for ${String(value)}`)
    return id
  }
  const guests = (raw.actions as Json[])
    .filter(action => action.kind === 'addPlayer')
    .map(action => sid(action.player))
  const setup = (old: Json): Json => {
    const players = old.players as Record<string, Json>
    const side = (held: Json): Json => ({
      ...held,
      players: (held.players as number[]).map(sid),
      battingOrder: (held.battingOrder as number[]).map(sid),
      defense: Object.fromEntries(
        Object.entries(held.defense as Record<string, number | null>).map(
          ([position, id]) => [position, id == null ? null : sid(id)]
        )
      ),
      pitchCounts: Object.fromEntries(
        Object.entries(held.pitchCounts as Record<string, number>).map(
          ([id, count]) => [sid(Number(id)), count]
        )
      )
    })
    const sides = old.sides as Record<'away' | 'home', Json>
    return {
      players: Object.fromEntries(
        Object.values(players).map(player => [
          sid(player.id),
          { ...player, id: sid(player.id), userId: player.id }
        ])
      ),
      sides: { away: side(sides.away), home: side(sides.home) },
      identities: {
        sourceToSession: Object.fromEntries(
          [...sessionOf].map(([id, session]) => [`number:${id}`, session])
        ),
        sessionToSource: Object.fromEntries(
          [...sessionOf].map(([id, session]) => [session, id])
        ),
        nextId: guests[0] ?? sessionOf.size + 1
      }
    }
  }
  const detail = (value: unknown, parent = ''): unknown => {
    if (Array.isArray(value)) return value.map(item => detail(item, parent))
    if (value == null || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'id' && (parent === 'player' || parent === 'runner')
          ? sid(item)
          : detail(item, key)
      ])
    )
  }
  return {
    ...raw,
    version: 1,
    setupBefore: setup(raw.setupBefore as Json),
    actions: (raw.actions as Json[]).map(action => {
      const mapped = mapPlayers(action, sid)
      if (action.setup != null) mapped.setup = setup(action.setup as Json)
      if (action.kind === 'addPlayer') delete mapped.player
      return mapped
    }),
    ...(raw.detail == null ? {} : { detail: detail(raw.detail) })
  }
}

/** The JSON of `value` with every name `names` maps replaced. */
function renamed<T>(value: T, names: Map<string, string>): T {
  let text = JSON.stringify(value)
  for (const [from, to] of [...names].sort((a, b) => b[0].length - a[0].length))
    text = text.split(from).join(to)
  return JSON.parse(text) as T
}

const addGuest = (side: 'away' | 'home', player: number): ScoringAction => ({
  type: 'lineup',
  kind: 'addPlayer',
  side,
  player,
  name:
    PEOPLE.find(person => person.gumboId === player)!.first +
    ' ' +
    PEOPLE.find(person => person.gumboId === player)!.last,
  jersey: '7'
})

interface StoredRows {
  plays: unknown[]
  currentPlay: unknown
  pregame: unknown
}

describe('092 player names from users', function () {
  this.timeout(120000)
  const name = `teamstation_names092_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  const notices: string[] = []
  /** Each game's named read before the migration. */
  const readBefore = new Map<string, unknown>()
  const rowsBefore = new Map<string, StoredRows>()
  /** Each game's book names, which its sentences were stored with. */
  const bookNames = new Map<string, Map<number, string>>()
  let archiveBefore: Json
  let refusedEvents = 0

  const insertPlay = async (
    id: string,
    gameId: string,
    gumbo: unknown,
    source = 'teamstation'
  ): Promise<void> => {
    await pool.query(
      `insert into events (id, "gameId", gumbo, source) values ($1, $2, $3, $4)`,
      [id, gameId, JSON.stringify(gumbo), source]
    )
  }
  const insertGame = async (
    id: string,
    plays: unknown[],
    currentPlay: unknown = null,
    pregame: unknown = null
  ): Promise<void> => {
    await pool.query(
      `insert into games (id, home_team_id, away_team_id, start_at,
         "currentPlay", pregame)
       values ($1, $2, $3, now(), $4, $5)`,
      [
        id,
        REPLAY_TEAMS.home.id,
        REPLAY_TEAMS.away.id,
        currentPlay == null ? null : JSON.stringify(currentPlay),
        pregame == null ? null : JSON.stringify(pregame)
      ]
    )
    for (const [index, play] of plays.entries())
      await insertPlay(`evt_${id.slice(4)}_${index}`, id, play)
  }
  const rowsOf = async (gameId: string): Promise<StoredRows> => {
    const plays = await pool.query<{ gumbo: unknown }>(
      `select gumbo from events where "gameId" = $1 order by "atBatIndex"`,
      [gameId]
    )
    const game = await pool.query<{ currentPlay: unknown; pregame: unknown }>(
      `select "currentPlay", pregame from games where id = $1`,
      [gameId]
    )
    return {
      plays: plays.rows.map(row => row.gumbo),
      currentPlay: game.rows[0].currentPlay,
      pregame: game.rows[0].pregame
    }
  }
  /** A game as its reader is answered: named from the accounts. */
  const namedRead = async (gameId: string): Promise<unknown> => {
    const rows = await rowsOf(gameId)
    return await resolveScoringGame(db, {
      plays: rows.plays as GumboPlay[],
      currentPlay: atBatOf(rows, rows.plays.length > 0) as CurrentPlay | null
    })
  }
  /**
   * Stores a game's sentences and names as the game's book names its
   * players, as a scorer's screen named them: the short names over the game.
   */
  const nameAsBook = async (gameId: string): Promise<void> => {
    const book = (await gameNames(db, [gameId])).get(gameId)!
    const names = new Map<string, string>()
    const byId = new Map<number, string>()
    for (const person of PEOPLE) {
      const short = book.nameOf(person.gumboId)
      if (short == null) continue
      names.set(`${person.first} ${person.last}`, short)
      byId.set(person.gumboId, short)
    }
    bookNames.set(gameId, byId)
    const rows = await pool.query<{ id: string; gumbo: unknown }>(
      `select id, gumbo from events where "gameId" = $1`,
      [gameId]
    )
    for (const row of rows.rows)
      await pool.query(`update events set gumbo = $2 where id = $1`, [
        row.id,
        JSON.stringify(renamed(row.gumbo, names))
      ])
    const game = await rowsOf(gameId)
    await pool.query(
      `update games set "currentPlay" = $2, pregame = $3 where id = $1`,
      [
        gameId,
        game.currentPlay == null
          ? null
          : JSON.stringify(renamed(game.currentPlay, names)),
        game.pregame == null
          ? null
          : JSON.stringify(renamed(game.pregame, names))
      ]
    )
  }

  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    pool = new Pool({ connectionString: url })
    pool.on('connect', client => {
      client.on('notice', notice => notices.push(notice.message ?? ''))
    })
    db = makeDatabase(url)
    await migrateUp(pool, before092)
    for (const person of PEOPLE) {
      const userId = userIdOfGumbo(person.gumboId)
      await pool.query(
        `insert into users (id, display_name, first_name, last_name, login_enabled)
         values ($1, $2, $3, $4, $5)`,
        [
          userId,
          `${person.first} ${person.last}`,
          person.first,
          person.last,
          !GUESTS.includes(person as never)
        ]
      )
      await pool.query(
        'insert into gumbo_ids (gumbo_id, user_id) values ($1, $2)',
        [person.gumboId, userId]
      )
    }
    await pool.query(`insert into teams (id, name) values ($1, $2), ($3, $4)`, [
      REPLAY_TEAMS.away.id,
      REPLAY_TEAMS.away.name,
      REPLAY_TEAMS.home.id,
      REPLAY_TEAMS.home.name
    ])
    const actions = replayActions()

    // The engine's game, stored with its sentences and no `said`, with its
    // pregame lineups and an archive of it, as a reset with a swap keeps.
    const engine = await scored(actions)
    const enginePlays = engine.plays.map(withoutSaid)
    await insertGame(
      'gam_engine',
      enginePlays,
      null,
      lineupsBefore(enginePlays[0])
    )
    await nameAsBook('gam_engine')

    // A version 2 record holding an `addPlayer` action, as an app kept it
    // before records were kept by team.
    const legacy2 = await scored([
      addGuest('away', SEAGER),
      ...actions.slice(0, 6)
    ])
    await insertGame(
      'gam_legacy2',
      legacy2.plays.map(play => withoutSaid(bySide(play))),
      withoutSaid(bySide(legacy2.currentPlay))
    )
    await nameAsBook('gam_legacy2')

    // Version 1 records, through Stanton's pinch hit after a wild pitch,
    // and a guest added in the at-bat in progress: in no setup, no play
    // and no credit.
    const hit = actions.findIndex(
      action =>
        action.type === 'lineup' &&
        action.kind === 'substitute' &&
        action.player === STANTON
    )
    const legacy1 = await scored([
      ...actions.slice(0, hit + 5),
      addGuest('home', WITT)
    ])
    const sessionOf = new Map(
      [...[...AWAY_PLAYERS, ...HOME_PLAYERS].map(p => p.gumboId), WITT].map(
        (id, index) => [id, index + 1]
      )
    )
    const version1 = (document: unknown): unknown => {
      const play = withoutSaid(bySide(document)) as Json | null
      if (play == null) return play
      return {
        ...play,
        teamStation: asVersion1(play.teamStation as Json, sessionOf)
      }
    }
    await insertGame(
      'gam_legacy1',
      legacy1.plays.map(version1),
      version1(legacy1.currentPlay)
    )
    await nameAsBook('gam_legacy1')

    // A sentence nothing words again, and a version 1 record whose
    // identities cannot be read.
    const pinch = (await rowsOf('gam_legacy1')).plays.find(play =>
      JSON.stringify(play).includes('offensive_substitution')
    ) as Json
    const engineHit = clone(
      (await rowsOf('gam_engine')).plays.find(play =>
        JSON.stringify(play).includes('offensive_substitution')
      ) as Json
    )
    for (const event of engineHit.playEvents as Json[])
      if ((event.details as Json).eventType === 'offensive_substitution')
        (event.details as Json).description =
          `${(event.details as Json).description as string} Again.`
    await insertGame('gam_unread', [engineHit])
    const refusedRecord = clone(pinch)
    ;((refusedRecord.teamStation as Json).setupBefore as Json).identities = {
      sourceToSession: {},
      sessionToSource: { 1: 9101 },
      nextId: 99
    }
    refusedEvents = (refusedRecord.playEvents as Json[]).filter(
      event =>
        event.isPitch !== true &&
        typeof (event.details as Json | undefined)?.description === 'string'
    ).length
    await insertGame('gam_refused', [refusedRecord])

    // An outside scorer's play with a typed opponent and a fielding chain,
    // a person's own play, and a credit stored already with no names.
    await insertGame('gam_outside', [])
    await insertPlay(
      'evt_outside',
      'gam_outside',
      {
        about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
        result: { eventType: 'field_out' },
        matchup: {
          batter: { fullName: 'Kyle Tucker' },
          pitcher: { id: FREEMAN, fullName: 'Freddie Freeman' }
        },
        credits: [
          {
            eventType: 'single',
            label: 'Single: Kyle Tucker',
            teamId: REPLAY_TEAMS.away.id,
            creditUserId: null,
            credit: { name: 'Kyle Tucker', role: 'batter', position: null }
          },
          {
            eventType: 'field_out',
            label: 'Ground out: Mookie Betts (SS) to Freddie Freeman (1B)',
            teamId: REPLAY_TEAMS.home.id,
            creditUserId: BETTS,
            credit: { name: 'Mookie Betts', role: 'fielder', position: 'SS' },
            assists: [
              { name: 'Freddie Freeman', position: '1B', creditUserId: FREEMAN }
            ]
          }
        ]
      },
      'external'
    )
    await insertPlay(
      'evt_manual',
      'gam_outside',
      {
        about: { atBatIndex: 1, inning: 1, halfInning: 'top' },
        result: { eventType: 'single' },
        matchup: { batter: { id: BETTS, fullName: 'Mookie Betts' } },
        playEvents: [
          {
            type: 'action',
            details: {
              eventType: 'single',
              description: 'Mookie Betts beats the throw'
            }
          }
        ]
      },
      'manual'
    )
    await insertPlay(
      'evt_typed',
      'gam_outside',
      {
        about: { atBatIndex: 2, inning: 1, halfInning: 'top' },
        result: { eventType: 'single' },
        credits: [
          {
            eventType: 'single',
            teamId: REPLAY_TEAMS.away.id,
            creditUserId: null,
            head: 'Single',
            credit: { name: 'Kyle Tucker', role: 'batter', position: null }
          }
        ]
      },
      'external'
    )

    // The archive of the engine's game, as a reset with a swap writes it.
    const engineRows = await pool.query<Json>(
      `select id, "atBatIndex", gumbo, hidden, "titleOverride",
         "timeNudgeSec", source
       from events where "gameId" = 'gam_engine' order by "atBatIndex"`
    )
    const engineGame = await rowsOf('gam_engine')
    await pool.query(
      `insert into game_play_archives (id, game_id, reason, home_team_id,
         away_team_id, status, current_play, pregame, play_generation,
         plays, players, tags)
       values ('gpa_engine', 'gam_engine', 'resetSwap', $1, $2, 'final',
         $3, $4, 0, $5, '[]', '[]')`,
      [
        REPLAY_TEAMS.home.id,
        REPLAY_TEAMS.away.id,
        JSON.stringify(engineGame.plays.at(-1)),
        JSON.stringify(engineGame.pregame),
        JSON.stringify(engineRows.rows)
      ]
    )
    archiveBefore = (
      await pool.query<Json>(
        `select current_play, pregame, plays from game_play_archives`
      )
    ).rows[0]

    for (const game of [
      'gam_engine',
      'gam_legacy2',
      'gam_legacy1',
      'gam_outside'
    ]) {
      rowsBefore.set(game, await rowsOf(game))
      readBefore.set(game, await namedRead(game))
    }
    await migrateUp(pool, through092)
  })

  after(async () => {
    await db?.destroy()
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  /** Every name of a game's players, whole and as the game reads them. */
  const namesOf = (gameId: string): string[] => [
    ...PEOPLE.flatMap(person => [`${person.first} ${person.last}`]),
    ...bookNames.get(gameId)!.values()
  ]

  it('reads the same named game after as before', async () => {
    // The same in every word: only each sentence's said is new.
    for (const game of ['gam_engine', 'gam_legacy2', 'gam_legacy1'])
      expect(withoutSaid(await namedRead(game)), game).deep.equals(
        readBefore.get(game)
      )
  })

  it('stores no name of anybody with an id in any play, at-bat or pregame', async () => {
    for (const game of ['gam_engine', 'gam_legacy2', 'gam_legacy1']) {
      const text = JSON.stringify(await rowsOf(game))
      for (const person of namesOf(game))
        expect(text, `${game} keeps ${person}`).not.include(person)
      expect(text).not.include('"label"')
    }
    const outside = JSON.stringify(await rowsOf('gam_outside'))
    for (const person of ['Mookie Betts', 'Freddie Freeman'])
      expect(outside.replace('Mookie Betts beats', '')).not.include(person)
    // A typed opponent is his own name, and a person's words are his.
    expect(outside).include('Kyle Tucker')
    expect(outside).include('Mookie Betts beats the throw')
  })

  it('gives every sentence of the base engine its said, reproduced', async () => {
    const plays = (await rowsOf('gam_engine')).plays as Json[]
    const hit = plays
      .flatMap(play => play.playEvents as Json[])
      .find(
        event => (event.details as Json).eventType === 'offensive_substitution'
      )!
    expect(hit.said).deep.equals({
      kind: 'pinch',
      player: STANTON,
      replaced: BADER,
      running: false
    })
    expect(hit.details).not.have.property('description')
    const reported = notices.filter(notice =>
      notice.startsWith('092playerNamesFromUsers:')
    )
    expect(reported).length(1)
    const counts =
      /(\d+) documents rewritten, (\d+) sentences not reproduced, (\d+) version 1 records refused/.exec(
        reported[0]
      )!
    // Only the altered sentence and the refused record's are not read back.
    expect(Number(counts[2])).equals(1 + refusedEvents)
    expect(Number(counts[3])).equals(1)
    expect(Number(counts[1])).greaterThan(0)
  })

  it('migrates a version 2 record with an addPlayer action, its guest named on replay as before', async () => {
    const rows = await rowsOf('gam_legacy2')
    const record = (rows.plays[0] as Json).teamStation as Json
    expect(record.version).equals(2)
    const add = (record.actions as Json[]).find(
      action => action.kind === 'addPlayer'
    )!
    expect(add).not.have.property('name')
    expect(add.player).equals(SEAGER)
    const context = replayContext()
    const replay = (read: unknown): string =>
      replayPlays(read as never, context).state.gameData.players[SEAGER]
        .fullName
    const now = await namedRead('gam_legacy2')
    expect(replay(now)).equals(replay(readBefore.get('gam_legacy2')))
    expect(replay(now)).equals(bookNames.get('gam_legacy2')!.get(SEAGER))
  })

  it('stores a version 1 record upgraded, its sentences given said by gumbo id, and replays it as before', async () => {
    const rows = await rowsOf('gam_legacy1')
    for (const play of [...rows.plays, rows.currentPlay] as Json[])
      expect((play.teamStation as Json).version).equals(2)
    const events = (rows.plays as Json[]).flatMap(
      play => play.playEvents as Json[]
    )
    const said = (type: string): unknown =>
      events.find(event => (event.details as Json).eventType === type)?.said
    expect(said('offensive_substitution')).deep.equals({
      kind: 'pinch',
      player: STANTON,
      replaced: BADER,
      running: false
    })
    expect(said('wild_pitch')).deep.include({
      kind: 'action',
      eventType: 'wild_pitch'
    })
    const add = (
      ((rows.currentPlay as Json).teamStation as Json).actions as Json[]
    ).find(action => action.kind === 'addPlayer')!
    expect(add).deep.include({ player: WITT })
    expect(add).not.have.property('name')
    const now = await namedRead('gam_legacy1')
    const context = replayContext()
    const state = (read: unknown): unknown => {
      const replay = replayPlays(read as never, context)
      return {
        players: Object.fromEntries(
          Object.entries(replay.state.gameData.players).map(([id, player]) => [
            id,
            player.fullName
          ])
        ),
        sentences: replay.state.liveData.plays.allPlays.flatMap(play =>
          play.playEvents
            .filter(event => event.type !== 'pitch')
            .map(event => event.details.description)
        )
      }
    }
    expect(state(now)).deep.equals(state(readBefore.get('gam_legacy1')))
    const read = state(now) as { players: Record<string, string> }
    expect(read.players[WITT]).equals(bookNames.get('gam_legacy1')!.get(WITT))
  })

  it('keeps a version 1 record it cannot upgrade at version 1, with no player names and its sentences', async () => {
    const [play] = (await rowsOf('gam_refused')).plays as Json[]
    const record = play.teamStation as Json
    expect(record.version).equals(1)
    for (const player of Object.values(
      (record.setupBefore as Json).players as Record<string, Json>
    )) {
      expect(player).not.have.property('fullName')
      expect(player).not.have.property('firstName')
    }
    const hit = (play.playEvents as Json[]).find(
      event => (event.details as Json).eventType === 'offensive_substitution'
    )!
    expect(hit).not.have.property('said')
    expect((hit.details as Json).description).a('string')
    // It still reads, as a play read from its document.
    await namedRead('gam_refused')
  })

  it('strips the names of a pregame and an archived game', async () => {
    const book = bookNames.get('gam_engine')!
    const pregame = (await rowsOf('gam_engine')).pregame
    for (const person of namesOf('gam_engine'))
      expect(JSON.stringify(pregame)).not.include(person)
    expect(withoutSaid(withNames(pregame, book))).deep.equals(
      withNames(rowsBefore.get('gam_engine')!.pregame, book)
    )
    const archive = (
      await pool.query<Json>(
        `select current_play, pregame, plays from game_play_archives`
      )
    ).rows[0]
    const text = JSON.stringify(archive)
    for (const person of namesOf('gam_engine'))
      expect(text, `the archive keeps ${person}`).not.include(person)
    expect(withoutSaid(withNames(archive.current_play, book))).deep.equals(
      withNames(archiveBefore.current_play, book)
    )
    const plays = (archive.plays as Json[]).map(row =>
      withoutSaid(withNames(row.gumbo, book))
    )
    expect(plays).deep.equals(
      (archiveBefore.plays as Json[]).map(row => withNames(row.gumbo, book))
    )
    expect((archive.plays as Json[])[0]).include({ source: 'teamstation' })
  })

  it('keeps a typed name only for a credit naming nobody by id, and drops the copies', async () => {
    const credits = await pool.query<{
      eventId: string
      creditGumboId: string | null
      typedName: string | null
      head: string
    }>(
      `select "eventId", "creditGumboId", "typedName", head from "eventCredits"`
    )
    expect(credits.rows.length).greaterThan(0)
    for (const row of credits.rows)
      if (row.creditGumboId != null)
        expect(row.typedName, row.head).equals(null)
    const typed = credits.rows.filter(row => row.typedName != null)
    expect(
      typed
        .map(row => `${row.eventId} ${row.typedName}`)
        .sort((a, b) => a.localeCompare(b))
    ).deep.equals(['evt_outside Kyle Tucker', 'evt_typed Kyle Tucker'])
    const columns = await pool.query<{
      table_name: string
      column_name: string
    }>(
      `select table_name, column_name from information_schema.columns
       where (table_name = 'eventCredits' and column_name in ('label', 'name'))
          or (table_name = 'games'
              and column_name in ('gumbo_game_data', 'boxscore'))`
    )
    expect(columns.rows).deep.equals([])
    // A play written now copies its structure and a typed name.
    await insertPlay('evt_later', 'gam_outside', {
      about: { atBatIndex: 3 },
      result: { eventType: 'field_out' },
      credits: [
        {
          eventType: 'field_out',
          teamId: REPLAY_TEAMS.home.id,
          creditUserId: null,
          head: 'Out at 1st',
          credit: { name: 'Jose Altuve', role: 'fielder', position: '1B' },
          assists: [
            { creditUserId: BETTS, position: 'SS' },
            { creditUserId: null, position: '2B', name: 'Kyle Tucker' }
          ],
          assistWord: 'from'
        },
        {
          eventType: 'field_out',
          teamId: REPLAY_TEAMS.home.id,
          creditUserId: null,
          head: 'Out',
          credit: { name: '', role: 'fielder', position: null }
        },
        {
          eventType: 'strikeout',
          teamId: REPLAY_TEAMS.home.id,
          creditUserId: BETTS,
          head: 'Strikeout',
          suffix: ' pitching',
          credit: { role: 'pitcher', position: 'P' },
          positionShown: false
        }
      ]
    })
    const later = await pool.query<Json>(
      `select head, "typedName", assists, "assistWord", "positionShown"
       from "eventCredits" where "eventId" = 'evt_later' order by head desc`
    )
    expect(later.rows).deep.equals([
      {
        head: 'Strikeout',
        typedName: null,
        assists: [],
        assistWord: null,
        positionShown: false
      },
      {
        head: 'Out at 1st',
        typedName: 'Jose Altuve',
        assists: [
          { gumboId: BETTS, position: 'SS' },
          { gumboId: null, position: '2B', name: 'Kyle Tucker' }
        ],
        assistWord: 'from',
        positionShown: true
      },
      {
        head: 'Out',
        typedName: null,
        assists: [],
        assistWord: null,
        positionShown: true
      }
    ])
  })

  it('cannot be rolled back', async () => {
    const refused = await migrateDown(pool, through092, 1).then(
      () => '',
      (error: unknown) => String(error)
    )
    expect(refused).contains('cannot be put back')
  })
})
