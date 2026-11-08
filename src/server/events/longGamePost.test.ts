import { expect } from 'chai'
import { type Kysely, type KyselyPlugin, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import {
  type GameSides,
  POSITIONS,
  randomFrom,
  scriptedGame
} from '../../../tools/dbLoad/scoredGames'
import type { PostEventsBody } from '../../common/gumboPlay'
import * as gumbo from '../../common/scoring/gumbo'
import * as storedNames from '../../common/scoring/storedNames'
import * as teamRecord from '../../common/scoring/teamRecord'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { closeInto } from '../admin/people'
import type { ValkeyCache } from '../cache/valkeyCache'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import * as openRow from '../scoring/openRow'
import { namesMergedAccounts } from '../scoring/openRow'
import { GAME_CHANGES_CHANNEL } from '../socket/gameChanges'
import { gameNamesDigest } from '../users/nameBook'
import {
  gamePlaysDigest,
  type PostedEdits,
  type PostedPlays,
  postGamePlays,
  readPlays
} from './postPlays'

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
  key: K,
  counts: (args: unknown[]) => boolean = () => true
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
    if (counts(args)) tally.calls += 1
    return real(...args)
  }
  return tally
}

/** Whether a call to `resolveScoringPlays` names every play of the game. */
const namesEveryPlay = (args: unknown[]): boolean =>
  (args[2] as { only?: unknown } | undefined)?.only == null

/**
 * Counts the documents named (`withNames`) other than by a named read of
 * the whole game (`resolveScoringGame`, or `resolveScoringPlays` asked for
 * every play), which a record post's checks make before writing, and an
 * answer of every play makes after.
 */
function namedOutsideWholeReads(): {
  calls: () => number
  restore: () => void
} {
  const names = storedNames as unknown as Record<
    'withNames',
    (...args: unknown[]) => unknown
  >
  const reads = openRow as unknown as Record<
    'resolveScoringGame' | 'resolveScoringPlays',
    (...args: unknown[]) => Promise<unknown>
  >
  const realNames = names.withNames
  const realWhole = reads.resolveScoringGame
  const realPlays = reads.resolveScoringPlays
  let depth = 0
  let calls = 0
  names.withNames = (...args: unknown[]) => {
    if (depth === 0) calls += 1
    return realNames(...args)
  }
  const whole =
    (real: (...args: unknown[]) => Promise<unknown>, every = () => true) =>
    async (...args: unknown[]) => {
      const counts = every()
      if (counts) depth += 1
      try {
        return await real(...args)
      } finally {
        if (counts) depth -= 1
      }
    }
  reads.resolveScoringGame = whole(realWhole)
  reads.resolveScoringPlays = async (...args: unknown[]) =>
    await whole(realPlays, () => namesEveryPlay(args))(...args)
  return {
    calls: () => calls,
    restore: () => {
      names.withNames = realNames
      reads.resolveScoringGame = realWhole
      reads.resolveScoringPlays = realPlays
    }
  }
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
  const namedPlays = counted(openRow, 'resolveScoringPlays', namesEveryPlay)
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
    namedPlays.restore()
    globalThis.TypeError = RealTypeError
  }
  return {
    replays: replays.calls,
    cleanedRecords: cleaned.calls,
    namedReads: named.calls + namedPlays.calls,
    documentsRead,
    typeErrors
  }
}

/**
 * What a post told the game socket of `gameId`: its plays notice on
 * `game_changes`, and each frame it left in Valkey, by key.
 */
interface Told<T> {
  result: T
  notice: Record<string, unknown>
  frames: Map<string, string>
}

async function toldDuring<T>(
  gameId: string,
  act: (cache: ValkeyCache) => Promise<T>
): Promise<Told<T>> {
  const frames = new Map<string, string>()
  const cache: ValkeyCache = {
    get: async key => frames.get(key) ?? null,
    set: async (key, value) => {
      frames.set(key, value)
    },
    close: async () => undefined
  }
  const listener = new Client({ connectionString: scratchUrl })
  await listener.connect()
  const notices: Array<Record<string, unknown>> = []
  listener.on('notification', message => {
    const payload = JSON.parse(message.payload ?? 'null') as Record<
      string,
      unknown
    > | null
    if (payload?.game === gameId && payload.kind === 'playEdits')
      notices.push(payload)
  })
  try {
    await listener.query(`listen ${GAME_CHANGES_CHANNEL}`)
    const result = await act(cache)
    // A round trip after the commit: its notices have arrived.
    await listener.query('select 1')
    expect(notices).length(1)
    return { result, notice: notices[0], frames }
  } finally {
    await listener.end()
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
    scoringMutation: undefined,
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

  describe('answering only what a live post wrote (M4)', function () {
    const gameId = 'gam_long_game_edits'
    let game: Awaited<ReturnType<typeof scriptedGame>>

    before(async function () {
      await newGame(gameId)
      game = await scriptedGame(gameId, sides, {
        innings: 64,
        final: false,
        random: randomFrom(17),
        reliefEvery: 3
      })
      expect(game.plays.length).at.least(600)
      await postGamePlays(
        db,
        gameId,
        live({ plays: game.plays, currentPlay: game.currentPlay })
      )
    })

    const edits = async (
      fields: Partial<PostEventsBody>,
      cache?: ValkeyCache
    ): Promise<PostedEdits> => {
      const answer = await postGamePlays(
        db,
        gameId,
        live(fields),
        undefined,
        undefined,
        { answer: 'edits', cache }
      )
      expect(answer).not.to.have.property('plays')
      return answer as PostedEdits
    }
    /** Every stored play, as `GET /games/:id/events` answers them. */
    const everyPlay = async (): Promise<PostedPlays> =>
      await postGamePlays(db, gameId, live({ plays: [] }))
    const digestNow = async (): Promise<string> =>
      await gamePlaysDigest(
        db,
        await db
          .selectFrom('games')
          .select(['id', 'currentPlay', 'pregame'])
          .where('id', '=', gameId)
          .executeTakeFirstOrThrow()
      )

    it('names only the at-bat for a pitch, and answers no play', async function () {
      const counting = namedOutsideWholeReads()
      let answer: PostedEdits
      try {
        answer = await edits({ plays: [], currentPlay: game.currentPlay })
      } finally {
        counting.restore()
      }
      // The pitch wrote no play: the at-bat alone is named.
      expect(counting.calls()).at.most(1)
      expect(answer.edits).deep.equals([])
      expect(answer.currentPlay).to.have.nested.property('about.atBatIndex')
      expect(answer.playsDigest).equals(await digestNow())
      expect(answer.priorPlaysDigest).equals(answer.playsDigest)
      expect(Object.keys(answer)).deep.equals([
        'edits',
        'currentPlay',
        'lineupsDigest',
        'playsDigest',
        'priorPlaysDigest',
        'generation'
      ])
    })

    it('names the play it writes and the at-bat, and puts that play as a read gives it', async function () {
      const last = game.plays[game.plays.length - 1]
      const counting = namedOutsideWholeReads()
      let told: Told<PostedEdits>
      try {
        told = await toldDuring(
          gameId,
          async cache =>
            await edits({ plays: [last], currentPlay: game.currentPlay }, cache)
        )
      } finally {
        counting.restore()
      }
      const answer = told.result
      // Edited plus one: the play and the at-bat, once for the sender and
      // the public alike.
      expect(counting.calls()).at.most(2)
      expect(answer.edits).length(1)
      const [put] = answer.edits
      if (put.op !== 'put') throw new Error('expected a put')
      const read = await everyPlay()
      const row = read.plays.find(
        each =>
          (each.gumbo as { about: { atBatIndex: number } }).about.atBatIndex ===
          last.about.atBatIndex
      )
      expect(put.play).deep.equals(row)
      expect(answer.currentPlay).deep.equals(read.currentPlay)
      expect(answer.playsDigest).equals(read.playsDigest)
      expect(answer.playsDigest).equals(await digestNow())

      // The game socket is told the same play, named for everybody, from
      // the book a read of the game is named from.
      const namesDigest = await gameNamesDigest(db, gameId)
      expect(told.notice).deep.equals({
        game: gameId,
        kind: 'playEdits',
        generation: answer.generation,
        fromDigest: answer.priorPlaysDigest,
        digest: answer.playsDigest,
        namesDigest,
        indexes: [last.about.atBatIndex],
        removed: []
      })
      expect([...told.frames.keys()]).deep.equals([
        `playEdits:${gameId}:${answer.generation}:${answer.priorPlaysDigest}:${answer.playsDigest}:${namesDigest}`
      ])
      expect(JSON.parse([...told.frames.values()][0])).deep.equals({
        generation: answer.generation,
        fromDigest: answer.priorPlaysDigest,
        digest: answer.playsDigest,
        namesDigest,
        edits: answer.edits,
        currentPlay: answer.currentPlay
      })
    })

    it('puts the plays its tag repair rewrote beside the ones it wrote', async function () {
      const [first, second] = await readPlays(db, gameId)
      // Two stored plays lose the tag identities a post's repair gives them.
      await db
        .updateTable('events')
        .set({ gumbo: sql`gumbo - 'tagTargets'` })
        .where('id', 'in', [first.id, second.id])
        .execute()
      const last = game.plays[game.plays.length - 1]
      const { result: answer, notice } = await toldDuring(
        gameId,
        async cache =>
          await edits({ plays: [last], currentPlay: game.currentPlay }, cache)
      )
      expect(
        answer.edits.map(edit =>
          edit.op === 'put'
            ? (edit.play.gumbo as { about: { atBatIndex: number } }).about
                .atBatIndex
            : -1
        )
      ).deep.equals([
        first.atBatIndex,
        second.atBatIndex,
        last.about.atBatIndex
      ])
      const read = await everyPlay()
      for (const edit of answer.edits)
        if (edit.op === 'put')
          expect(edit.play).deep.equals(
            read.plays.find(row => row.id === edit.play.id)
          )
      expect(notice.indexes).deep.equals([
        first.atBatIndex,
        second.atBatIndex,
        last.about.atBatIndex
      ])
    })

    it('answers a remove for a play it takes away, and every play when asked', async function () {
      const last = game.plays[game.plays.length - 1]
      const { result: answer, notice } = await toldDuring(
        gameId,
        async cache =>
          await edits(
            {
              plays: [],
              remove: [last.about.atBatIndex],
              currentPlay: game.currentPlay
            },
            cache
          )
      )
      expect(answer.edits).deep.equals([
        { op: 'remove', atBatIndex: last.about.atBatIndex }
      ])
      expect(notice.removed).deep.equals([last.about.atBatIndex])
      expect(answer.playsDigest).equals(await digestNow())

      // Asked for every play, it answers them as before, and names what it
      // wrote for the public in the same pass: nothing is named outside it.
      const counting = namedOutsideWholeReads()
      let all: Told<PostedPlays>
      try {
        all = await toldDuring(
          gameId,
          async cache =>
            await postGamePlays(
              db,
              gameId,
              live({ plays: [last], currentPlay: game.currentPlay }),
              undefined,
              undefined,
              { answer: 'all', cache }
            )
        )
      } finally {
        counting.restore()
      }
      expect(counting.calls()).equals(0)
      expect(all.result.plays).length(game.plays.length)
      expect(all.result.playsDigest).equals(await digestNow())
      expect(all.notice.indexes).deep.equals([last.about.atBatIndex])
      expect(all.frames.size).equals(1)
    })

    for (const asked of ['edits', 'all'] as const)
      it(`leaves the game socket a frame with none of its sender's full names (answer ${asked})`, async function () {
        const players = [...sides.away.players, ...sides.home.players].map(
          player => userIdOfGumbo(player.gumboId)
        )
        await db
          .updateTable('users')
          .set({ first_name: 'Given', last_name: 'Family' })
          .where('id', 'in', players)
          .execute()
        try {
          const held = new Map<string, string>()
          const cache: ValkeyCache = {
            get: async key => held.get(key) ?? null,
            set: async (key, value) => {
              held.set(key, value)
            },
            close: async () => undefined
          }
          const last = game.plays[game.plays.length - 1]
          const answer = await postGamePlays(
            db,
            gameId,
            live({ plays: [last], currentPlay: game.currentPlay }),
            undefined,
            undefined,
            // A scorer of both teams is answered their players' halves.
            { answer: asked, cache, halves: async () => [HOME, AWAY] }
          )
          expect(JSON.stringify(answer)).includes('"firstName":"Given"')
          expect(held.size).equals(1)
          const [frame] = [...held.values()]
          // Everybody reads the short names alone.
          expect(frame).not.includes('"firstName"')
          expect(frame).not.includes('"lastName"')
          expect(frame).not.includes('Family')
          const shared = JSON.parse(frame) as {
            edits: Array<{ op: string; play: { id: string } }>
          }
          expect(shared).to.include({
            generation: answer.generation,
            fromDigest: answer.priorPlaysDigest,
            digest: answer.playsDigest
          })
          // The play it wrote, and only that one.
          expect(shared.edits.map(edit => edit.op)).deep.equals(['put'])
        } finally {
          await db
            .updateTable('users')
            .set({ first_name: null, last_name: null })
            .where('id', 'in', players)
            .execute()
        }
      })
  })

  it('answers every play to a post that is not live, whatever it asks', async function () {
    const gameId = 'gam_long_game_replace'
    await newGame(gameId)
    const game = await scriptedGame(gameId, sides, {
      innings: 1,
      final: false,
      random: randomFrom(19)
    })
    const {
      result: answer,
      notice,
      frames
    } = await toldDuring(
      gameId,
      async cache =>
        await postGamePlays(
          db,
          gameId,
          posted('manual', { mode: 'replace', plays: game.plays }),
          undefined,
          undefined,
          { answer: 'edits', cache }
        )
    )
    expect(answer).to.have.property('plays').length(game.plays.length)
    // Read again: no edits are named, only the digest it left.
    expect(notice).deep.equals({
      game: gameId,
      kind: 'playEdits',
      generation: 0,
      digest: (answer as { playsDigest: string }).playsDigest,
      namesDigest: await gameNamesDigest(db, gameId)
    })
    expect(frames.size).equals(0)
  })

  it('names nothing for the public when a live post leaves only the pregame lineups', async function () {
    const gameId = 'gam_long_game_pregame'
    await newGame(gameId)
    // A reader is answered them folded into an at-bat, after the commit.
    await db
      .updateTable('games')
      .set({
        pregame: {
          version: 3,
          setupBefore: { players: {}, teams: {}, tagOrder: [] },
          actions: []
        }
      })
      .where('id', '=', gameId)
      .execute()
    const {
      result: answer,
      notice,
      frames
    } = await toldDuring(
      gameId,
      async cache =>
        await postGamePlays(
          db,
          gameId,
          live({ plays: [] }),
          undefined,
          undefined,
          { answer: 'edits', cache }
        )
    )
    expect(answer).to.have.property('edits').deep.equals([])
    expect(notice).deep.equals({
      game: gameId,
      kind: 'playEdits',
      generation: 0,
      digest: (answer as { playsDigest: string }).playsDigest,
      namesDigest: await gameNamesDigest(db, gameId)
    })
    expect(frames.size).equals(0)
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
    ): Promise<PostedPlays> =>
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
