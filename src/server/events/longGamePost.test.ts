import { expect } from 'chai'
import type { Kysely, KyselyPlugin } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import {
  type GameSides,
  POSITIONS,
  randomFrom,
  scriptedGame
} from '../../../tools/dbLoad/scoredGames'
import type { PostEventsBody } from '../../common/gumboPlay'
import * as gumbo from '../../common/scoring/gumbo'
import * as teamRecord from '../../common/scoring/teamRecord'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { closeInto } from '../admin/people'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import * as openRow from '../scoring/openRow'
import { namesMergedAccounts } from '../scoring/openRow'
import { gamePlaysDigest, postGamePlays, readPlays } from './postPlays'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_long_game_post_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const HOME = 'tem_long_game_home'
const AWAY = 'tem_long_game_away'

const roster = (base: number): GameSides['home']['players'] =>
  Array.from({ length: 12 }, (_, i) => ({
    gumboId: base + i,
    first: 'Load',
    last: `Player ${i}`,
    ...(i < POSITIONS.length ? { position: POSITIONS[i] } : {})
  }))
const sides: GameSides = {
  away: { id: AWAY, name: 'Away', players: roster(1000) },
  home: { id: HOME, name: 'Home', players: roster(2000) }
}

/** Counts the calls to a function other modules reach through its exports. */
function counted<K extends string>(
  exports: unknown,
  key: K
): { calls: number; restore: () => void } {
  const module = exports as Record<K, (...args: unknown[]) => unknown>
  const real = module[key]
  const tally = {
    calls: 0,
    restore: () => {
      module[key] = real
    }
  }
  module[key] = (...args: unknown[]) => {
    tally.calls += 1
    return real(...args)
  }
  return tally
}

interface Work {
  replays: number
  /** Records cleaned, each of them a full read of a play's setup. */
  cleanedRecords: number
  /** Named reads of the whole game. */
  namedReads: number
  /** Stored plays parsed out of the database. */
  documentsRead: number
  /** Exceptions the cleaners throw, and catch, on data that is valid. */
  typeErrors: number
}

/** The work `post` does, by what it counts rather than how long it takes. */
async function workOf(
  db: Kysely<Database>,
  post: (db: Kysely<Database>) => Promise<unknown>
): Promise<Work> {
  const replays = counted(gumbo, 'replayPlays')
  const cleaned = counted(teamRecord, 'recordBySide')
  const named = counted(openRow, 'resolveScoringGame')
  const RealTypeError = globalThis.TypeError
  let typeErrors = 0
  let documentsRead = 0
  globalThis.TypeError = class extends RealTypeError {
    constructor(message?: string) {
      super(message)
      typeErrors += 1
    }
  } as unknown as TypeErrorConstructor
  const reads: KyselyPlugin = {
    transformQuery: args => args.node,
    transformResult: async ({ result }) => {
      for (const row of result.rows)
        if (row != null && typeof row === 'object' && 'gumbo' in row)
          documentsRead += 1
      return result
    }
  }
  try {
    await post(db.withPlugin(reads))
  } finally {
    replays.restore()
    cleaned.restore()
    named.restore()
    globalThis.TypeError = RealTypeError
  }
  return {
    replays: replays.calls,
    cleanedRecords: cleaned.calls,
    namedReads: named.calls,
    documentsRead,
    typeErrors
  }
}

describe('a post in a long game', function () {
  this.timeout(120_000)

  let adminPool: Pool | undefined
  let db: Kysely<Database>

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
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    await insertFixtureUsers(
      db,
      [...sides.away.players, ...sides.home.players].map(player => ({
        id: player.gumboId,
        display_name: `${player.first} ${player.last}`,
        created_at: new Date()
      }))
    )
    await db
      .insertInto('teams')
      .values([
        { id: HOME, name: 'Home' },
        { id: AWAY, name: 'Away' }
      ])
      .execute()
  })

  after(async function () {
    if (adminPool == null) return
    await db.destroy()
    await adminPool.query(`drop database if exists ${scratchName}`)
    await adminPool.end()
  })

  const newGame = async (id: string): Promise<void> => {
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: HOME,
        away_team_id: AWAY,
        start_at: new Date(),
        status: 'scheduled'
      })
      .execute()
  }

  const posted = (
    system: 'teamstation' | 'manual',
    fields: Partial<PostEventsBody>
  ): PostEventsBody => ({
    mode: 'live',
    source: { system },
    plays: [],
    currentPlay: undefined,
    remove: undefined,
    fenceDistanceFt: undefined,
    lineupsBase: undefined,
    generation: undefined,
    ...fields
  })
  const live = (fields: Partial<PostEventsBody>): PostEventsBody =>
    posted('teamstation', fields)

  const readDigest = async (gameId: string): Promise<string | null> =>
    (
      await db
        .selectFrom('games')
        .select('lineups_digest')
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
    ).lineups_digest

  it('does a bounded amount of work for one pitch, however long the game', async function () {
    const gameId = 'gam_long_game_work'
    await newGame(gameId)
    const game = await scriptedGame(gameId, sides, {
      innings: 8,
      final: false,
      random: randomFrom(11),
      reliefEvery: 3
    })
    const pitch = { plays: [], currentPlay: game.currentPlay }
    await postGamePlays(
      db,
      gameId,
      live({ plays: game.plays, currentPlay: game.currentPlay })
    )
    const plays = game.plays.length
    expect(plays).above(60)

    const work = await workOf(db, async counting => {
      await postGamePlays(counting, gameId, live(pitch))
    })

    // Its lineups digest needs the one replay; nothing else asks for another.
    expect(work.replays).equals(1)
    // As the post finds the game, its check before writing and its answer.
    expect(work.namedReads).at.most(3)
    expect(work.documentsRead).at.most(plays)
    // The stored records once, and the named ones of those three reads.
    expect(work.cleanedRecords).at.most(5 * (plays + 1))
    // A handful, not some for every play.
    expect(work.typeErrors).below(plays / 4)

    // That work still gave what a read gives.
    const stored = await readPlays(db, gameId)
    expect(stored).length(plays)
  })

  it('reads a game naming a merged account as its reader would', async function () {
    const gameId = 'gam_long_game_merged'
    await newGame(gameId)
    const game = await scriptedGame(gameId, sides, {
      innings: 1,
      final: false,
      random: randomFrom(13)
    })
    await postGamePlays(
      db,
      gameId,
      live({ plays: game.plays, currentPlay: game.currentPlay })
    )
    expect(await namesMergedAccounts(db, game)).equals(false)
    const [closing, keeping] = sides.home.players.slice(-2)
    await closeInto(
      db,
      userIdOfGumbo(closing.gumboId),
      userIdOfGumbo(keeping.gumboId)
    )
    expect(await namesMergedAccounts(db, game)).equals(true)

    const before = await readDigest(gameId)
    const work = await workOf(db, async counting => {
      await postGamePlays(
        counting,
        gameId,
        live({ plays: [], currentPlay: game.currentPlay })
      )
    })
    // The stored form for its digest, and the named read besides.
    expect(work.replays).at.least(2)
    // A merge moves no digest: it is of the lineups as stored.
    expect(await readDigest(gameId)).equals(before)
  })

  it('tries a new lineup action, which a pitch does not need', async function () {
    const gameId = 'gam_long_game_lineup'
    await newGame(gameId)
    const game = await scriptedGame(gameId, sides, {
      innings: 2,
      final: false,
      random: randomFrom(12)
    })
    await postGamePlays(
      db,
      gameId,
      live({ plays: game.plays, currentPlay: game.currentPlay })
    )
    const raw = (game.currentPlay as unknown as { teamStation: object })
      .teamStation as { actions: unknown[]; actionTimes?: string[] }
    const changed = {
      ...game.currentPlay,
      teamStation: {
        ...raw,
        actions: [
          ...raw.actions,
          {
            type: 'lineup',
            kind: 'substitute',
            side: 'away',
            playerIn: sides.away.players[10].gumboId,
            playerOut: sides.away.players[0].gumboId,
            position: 'P',
            mode: 'replace'
          }
        ],
        ...(raw.actionTimes == null
          ? {}
          : { actionTimes: [...raw.actionTimes, '2026-09-26T17:00:00.000Z'] })
      }
    }
    const work = await workOf(db, async counting => {
      await postGamePlays(
        counting,
        gameId,
        live({
          plays: [],
          currentPlay: changed as PostEventsBody['currentPlay']
        })
      ).catch(() => undefined)
    })
    // The new action was tried on a replay of its own, whatever it decided.
    expect(work.replays).at.least(1)
  })

  it('answers with the plays as stored, after writing some and removing others', async function () {
    const gameId = 'gam_long_game_rows'
    await newGame(gameId)
    const document = (
      atBatIndex: number,
      description = 'Single'
    ): PostEventsBody['plays'][number] =>
      ({
        about: {
          atBatIndex,
          inning: 1,
          halfInning: 'top',
          isScoringPlay: false
        },
        count: { outs: 0 },
        result: {
          eventType: 'single',
          awayScore: 0,
          homeScore: 0,
          description
        },
        playEvents: [{ isPitch: true }]
      }) as unknown as PostEventsBody['plays'][number]
    const post = async (
      fields: Partial<PostEventsBody>
    ): ReturnType<typeof postGamePlays> =>
      await postGamePlays(db, gameId, posted('manual', fields))
    await post({ plays: [0, 1, 2, 4, 5].map(i => document(i)) })

    // A play rewritten, one removed, one written between two others.
    const answer = await post({
      plays: [document(1, 'Rewritten'), document(3)],
      remove: [4]
    })

    const stored = await readPlays(db, gameId)
    const indexes = (rows: typeof stored): number[] =>
      rows.map(row => row.atBatIndex)
    expect(indexes(stored)).deep.equals([0, 1, 2, 3, 5])
    expect(
      answer.plays.map(
        row => (row.gumbo as { about: { atBatIndex: number } }).about.atBatIndex
      )
    ).deep.equals([0, 1, 2, 3, 5])
    expect(answer.plays.map(row => row.id)).deep.equals(
      stored.map(row => row.id)
    )
    expect(
      (answer.plays[1].gumbo as { result: { description: string } }).result
        .description
    ).equals('Rewritten')
    const row = await db
      .selectFrom('games')
      .select(['id', 'currentPlay', 'pregame'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(answer.playsDigest).equals(await gamePlaysDigest(db, row))

    // A post that writes no play at all changes none of them.
    const again = await post({ plays: [] })
    expect(again.playsDigest).equals(answer.playsDigest)
  })
})
