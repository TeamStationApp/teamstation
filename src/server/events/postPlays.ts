import { createHash } from 'node:crypto'

import { type Kysely, type Selectable, sql, type Transaction } from 'kysely'

import { badRequest, conflict, notFound } from '../../common/errors'
import { withPreviousTagIdentities } from '../../common/eventTags'
import type {
  PlayEdit,
  PlayEditsData,
  WirePlayRow
} from '../../common/gameSocket'
import type {
  CurrentPlay,
  GumboPlay,
  PostEventsBody
} from '../../common/gumboPlay'
import { recordOf, storedRecordOf } from '../../common/scoring/gumbo'
import {
  halfOutcomes,
  lineScore,
  withHalfOuts
} from '../../common/scoring/linescore'
import { radarTargets, withRadarSpeeds } from '../../common/scoring/radarSpeeds'
import type { StoredGame } from '../../common/scoring/session'
import { pregameRecord } from '../../common/scoring/sideSwap'
import { withoutNames } from '../../common/scoring/storedNames'
import { teamsOfRow } from '../../common/teamLists'
import { lockPlayerEdits } from '../admin/people'
import type { ValkeyCache } from '../cache/valkeyCache'
import { lockGameTeams } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database, EventsTable } from '../db/database'
import { resolvedFenceDistance } from '../games/fenceDistance'
import { scoringActivitySql } from '../games/scoringActivity'
import { radarSettings } from '../nodeSettings'
import { assertStoredScoringRoles } from '../scoring/mergeConflicts'
import {
  type NamedPlays,
  type ReaderNames,
  resolveScoringGame,
  resolveScoringPlays,
  scoringIdsIn
} from '../scoring/openRow'
import { contextOf } from '../scoring/replayContext'
import { assertAuthoredRosters } from '../scoring/rosterWrites'
import {
  MAX_NOTICE_INDEXES,
  notifyGameChange,
  PLAY_EDITS_TTL_MS,
  playEditsKey
} from '../socket/gameChanges'
import { noteGameFigures, noteScopeChange } from '../socket/syncRevision'
import { type GamePlayerRow, gamePlayers } from '../users/nameBook'
import type { Reader } from '../users/readerNames'
import { atBatOf, postedAtBat, PREGAME_ABOUT } from './atBatInProgress'
import { pregameFold } from './currentPlay'
import { repairEventTags } from './eventTags'
import {
  type PlaySource,
  type PlayWrite,
  replaceGameEvents,
  teamIdsOnCredits,
  upsertGameEvents
} from './eventWrite'
import { radarReadings, scheduleRadarRefresh } from './radarSpeeds'
import {
  keepLineups,
  storedLineupGame,
  storedLineupsDigest
} from './teamLineups'
import { bodyFromWire, playForWire } from './wireRecords'

type Trx = Kysely<Database>

/** The refusal of a record made for teams this game no longer has. */
export const OTHER_TEAMS = "This game's teams changed since this was scored"

/** The game row a post is checked against, locked until it commits. */
export interface PostedGame {
  home_team_id: string
  away_team_id: string
}

/**
 * What a post answers: every stored play (`all`), or on a live post only the
 * plays it wrote (`edits`), as `PostedEdits`. A post that is not live
 * answers every play whichever is asked.
 */
export type PostAnswer = 'edits' | 'all'

/** What every post's answer says of the game it leaves. */
export interface PostedDigests {
  /**
   * The digest the game keeps of its lineups once this post is written, read
   * in its transaction: the base a sender's next live post names. Null only
   * for a replace post to a game no live post has written.
   */
  lineupsDigest: string | null
  /**
   * A digest of the stored plays and the at-bat in progress once this post
   * is written, as `GET /events` and the game socket's `playEdits` give it.
   */
  playsDigest: string
  /**
   * On a live post, the same digest of the game as this post found it: when
   * it is the one its sender last had, everything stored now is the
   * sender's own, and a notice carrying `playsDigest` is its own echo.
   */
  priorPlaysDigest: string | null
  /** The game's play generation, which a post never changes. */
  generation: number
}

/** A post's answer of every stored play (`all`). */
export interface PostedPlays extends PostedDigests {
  plays: WirePlayRow[]
  currentPlay: unknown
  /** Whom `PostOptions.listFullNamesFor` reads in full (`namedScoringGame`). */
  readerNames?: ReaderNames
}

/**
 * A live post's answer of only what it wrote (`edits`): a put of each play it
 * wrote and each one its tag repair rewrote, in index order, then a remove
 * of each index it took away, and the at-bat in progress.
 */
export interface PostedEdits extends PostedDigests {
  edits: PlayEdit[]
  currentPlay: unknown
}

/**
 * The plays a live post wrote, named as every viewer of the game is answered
 * them (no player's halves): what the game socket may send each viewer of
 * the post, as delivery would name it.
 */
interface PublicPlayEdits {
  generation: number
  /** The digest of the game as the post found it, which the edits apply to. */
  fromDigest: string | null
  /** The digest of the game once the edits are applied. */
  digest: string
  /** The digest of the book the edits are named from (`NameBook.digest`). */
  namesDigest: string
  /** The indexes of the plays put, in index order. */
  indexes: number[]
  /** The indexes taken away. */
  removed: number[]
  edits: PlayEdit[]
  currentPlay: unknown
}

/**
 * What a post asking for `A` answers: every play when it asks for them, and
 * when it asks for its edits, those or (not being live) every play.
 */
export type PostedAnswer<A extends PostAnswer> = A extends 'all'
  ? PostedPlays
  : PostedPlays | PostedEdits

/** What a client's post says about the game it was made against. */
export interface PostOptions {
  /**
   * The play generation the sender opened the game on. A client route
   * passes it; the server's own writes pass none and are not checked.
   */
  expectedGeneration?: number
  /**
   * The teams whose players' first and last names the answer
   * carries (`ScoringReadOptions.halves`), asked of the locked game: the
   * route answers its sender the teams whose lineups he may save. None when
   * absent.
   */
  halves?: (trx: Trx, game: PostedGame) => Promise<readonly string[]>
  /**
   * What the answer holds (`PostAnswer`). Every play when absent: a caller
   * inside the server reads `plays` whole.
   */
  answer?: PostAnswer
  /**
   * Whom an answer of every play says, by gumbo id, which of the game's
   * players it reads in full (`readerNames`): its plays stay named as the
   * public reads them. None for an edits answer.
   */
  listFullNamesFor?: Reader
  /**
   * Where a live post leaves the game socket's frame of what it wrote, named
   * as the public reads it (`playEditsKey`). Without one, each worker
   * delivering the notice reads and names the plays itself.
   */
  cache?: ValkeyCache
}

/** The refusal of a post made against the game before its last reset. */
export const RESET_SINCE_READ = 'This game was reset since it was read'

/**
 * Writes a checked post to a game: the plays, the half's outs on each half's
 * last play, the credits' team ids, the line score, the at-bat in progress
 * and the status, as `POST /games/:gameId/events` describes. `authorize`
 * sees the locked game row first and throws to refuse the post; the route
 * asks there whether its sender may score the game. The refold script, which
 * rewrites TeamStation's own plays, passes none. `written` is told the
 * answer last, in the post's transaction, before it announces: where a queued
 * post's `Idempotency-Key` keeps it. It sees a pregame at-bat as stored,
 * since the answer folds it only after the commit.
 *
 * A live post that leaves more than the pregame lineups names the plays it
 * wrote as the public reads them too, in the same pass as its answer, and the
 * game socket is sent those (`notifyPlayEdits`). One that names a person the
 * game's plays and at-bat did not, which can change the short names of others
 * on plays it did not write, has every viewer read the game again.
 */
export async function postGamePlays<A extends PostAnswer = 'all'>(
  db: Kysely<Database>,
  gameId: string,
  sentBody: PostEventsBody,
  authorize?: (trx: Trx, game: PostedGame) => Promise<void>,
  written?: (
    trx: Transaction<Database>,
    posted: PostedPlays | PostedEdits
  ) => Promise<void>,
  options: PostOptions & { answer?: A } = {}
): Promise<PostedAnswer<A>> {
  // TeamStation and a person typing name themselves. Every other sender, and
  // a post that names none, is an outside scorer: the least trusted one.
  const sent = sentBody.source?.system
  const system: PlaySource =
    sent === 'teamstation' || sent === 'manual' ? sent : 'external'
  const indexes = sentBody.plays.map(play => play.about.atBatIndex)
  if (new Set(indexes).size !== indexes.length) {
    throw badRequest('Two plays share an about.atBatIndex')
  }
  const unread = [...sentBody.plays, sentBody.currentPlay].find(
    play => play != null && !readableVersion(play)
  )
  if (unread != null)
    throw badRequest(
      `Play ${unread.about.atBatIndex}: teamStation must be a valid version 1, 2 or 3 record`
    )
  let refreshDelay: number | undefined
  /** The answer's at-bat, folded once the row is let go (`pregameFold`). */
  let folding:
    | {
        fold: () => Promise<CurrentPlay | null>
        sides: ReturnType<typeof teamsOfRow>
      }
    | undefined

  return await atomic(db, async (trx): Promise<PostedPlays | PostedEdits> => {
    await lockPlayerEdits(trx)
    await lockGameTeams(trx, gameId)
    // The game row stays locked until this post commits, so a second
    // post to the same game waits and then sees the plays, the final
    // status and the scoring owner this one leaves behind.
    const game = await trx
      .selectFrom('games')
      .select([
        'home_team_id',
        'away_team_id',
        'scoringOwner',
        'status',
        'cancellation_reason',
        'away_score',
        'home_score',
        'ingest_status',
        'ingest_message',
        'currentPlay',
        'pregame',
        'lineup_started_at',
        'lineups_digest',
        'play_generation',
        // The rest of what a list shows of the game (`listFieldsChanged`).
        'linescore',
        'start_at',
        'venue',
        'field_id'
      ])
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (game == null) throw notFound()
    // Stored by team: a record posted by side, as an app not yet updated
    // sends it, is turned to the game's teams.
    const body = bodyFromWire(sentBody, teamsOfRow(game))
    // A record naming other teams was made before this game's teams were
    // replaced: read under them, it would hold nothing.
    if (
      [...body.plays, body.currentPlay].some(
        play =>
          storedRecordOf(play) != null &&
          recordOf(play, teamsOfRow(game)) == null
      )
    )
      throw conflict(OTHER_TEAMS, { stale: true })
    const prepared = withHalfOuts(body.plays)
    // The game's plays as this post finds them, read once, after the lock
    // and before its writes: a post that held the lock first has fixed the
    // fence already, and they tell its sender whether anybody else wrote to
    // the game since.
    const priorRows = await readPlays(trx, gameId)
    const hadPlays = priorRows.length > 0
    const live = body.mode === 'live'
    if (
      game.status === 'final' &&
      !(live && system === 'teamstation' && game.scoringOwner === 'teamstation')
    ) {
      throw conflict('This game is final')
    }
    if (authorize != null) await authorize(trx, game)
    if (system === 'external' && game.scoringOwner === 'teamstation') {
      throw conflict('This game is scored in TeamStation')
    }
    // A post made against the plays a reset deleted belongs to none of
    // these: its sender reads the game again and opens it afresh.
    if (
      options.expectedGeneration !== undefined &&
      options.expectedGeneration !== game.play_generation
    )
      throw conflict(RESET_SINCE_READ, {
        stale: true,
        generation: game.play_generation
      })
    // A live post built on lineups somebody has saved over since would
    // write the old ones back: the sender reads the game again and posts
    // its own changes on top.
    const prior = live
      ? playsDigest(priorRows, atBatOf(game, priorRows.length > 0))
      : null
    // The lineups digest the game answers before this post: the one it
    // keeps, or for a game that keeps none, its stored form's; none when
    // that stored form does not read, so the post tells a lineups change
    // and a post built on a base is refused as the read is.
    const lineupsBefore = live
      ? await storedLineupsDigest(trx, { id: gameId, ...game }).catch(
          () => null
        )
      : null
    if (
      live &&
      body.lineupsBase !== undefined &&
      body.lineupsBase !==
        (lineupsBefore ??
          (await storedLineupsDigest(trx, { id: gameId, ...game })))
    )
      throw conflict(
        'Somebody else changed the lineups since this game was read',
        { stale: true }
      )

    const previous = {
      plays: priorRows.map(row => row.gumbo as GumboPlay),
      currentPlay: atBatOf(game, priorRows.length > 0) as CurrentPlay | null
    }
    const nextPlays = new Map(
      (live ? previous.plays : []).map(play => [play.about.atBatIndex, play])
    )
    for (const index of body.remove ?? []) nextPlays.delete(index)
    for (const play of body.plays) nextPlays.set(play.about.atBatIndex, play)
    const nextList = [...nextPlays.values()]
    const next = {
      plays: nextList,
      currentPlay: postedAtBat(
        game,
        nextList,
        live ? body.currentPlay : undefined
      ) as CurrentPlay | null
    }
    // The game's `event_players` as this post finds them, read at most once.
    let playersRead: Promise<GamePlayerRow[]> | undefined
    const playersBefore = async (): Promise<GamePlayerRow[]> =>
      await (playersRead ??= gamePlayers(trx, [gameId]).then(
        read => read.get(gameId) ?? []
      ))
    if (
      [...next.plays, next.currentPlay].some(
        play => storedRecordOf(play) != null
      )
    ) {
      // Nothing is written yet, so both reads name over the same players.
      const players = await playersBefore()
      const projected = await resolveScoringGame(trx, next, { gameId, players })
      await assertStoredScoringRoles(
        trx,
        { id: gameId, ...game },
        next,
        projected
      )
      const context = (await contextOf(trx, gameId, game, projected))!
      assertAuthoredRosters(
        await resolveScoringGame(trx, previous, { gameId, players }),
        projected,
        context
      )
    } else await assertStoredScoringRoles(trx, { id: gameId, ...game }, next)
    // Everyone the game's book was made over before this post (`scopeOf`):
    // its plays, its at-bat and its `event_players`. A post that leaves the
    // plays and at-bat naming the same people, and rewrites or removes no
    // stored play, leaves the `event_players` naming them too, since those
    // are copied from each play's own people (`eventChildren`): the rows are
    // read, before the writes, only for a post that may move the scope.
    const idsBefore = new Set(live ? scoringIdsIn(previous) : [])
    const storedBefore = new Set(
      previous.plays.map(play => play.about.atBatIndex)
    )
    const mayMoveScope =
      live &&
      (!sameIds(idsBefore, new Set(scoringIdsIn(next))) ||
        (body.remove ?? []).some(index => storedBefore.has(index)) ||
        body.plays.some(play => storedBefore.has(play.about.atBatIndex)))
    const scopeBefore = new Set(idsBefore)
    if (mayMoveScope)
      for (const row of await playersBefore()) scopeBefore.add(row.gumboId)

    const teams = {
      homeTeamId: game.home_team_id,
      awayTeamId: game.away_team_id
    }
    const priorCurrent = game.currentPlay as Partial<GumboPlay> | null
    // The at-bat the checks above were made on.
    let currentPlay: unknown = next.currentPlay
    if (currentPlay != null && typeof currentPlay === 'object') {
      const incoming = currentPlay as Partial<GumboPlay>
      if (typeof incoming.about?.atBatIndex === 'number') {
        const prior =
          priorCurrent?.about?.atBatIndex === incoming.about.atBatIndex
            ? priorCurrent
            : ((
                await trx
                  .selectFrom('events')
                  .select('gumbo')
                  .where('gameId', '=', gameId)
                  .where('atBatIndex', '=', incoming.about.atBatIndex)
                  .executeTakeFirst()
              )?.gumbo as Partial<GumboPlay> | undefined)
        if (prior != null)
          currentPlay = withPreviousTagIdentities(
            incoming as GumboPlay,
            prior,
            false
          )
      }
    }
    let plays: PlayWrite[] = prepared.map(play => ({
      gumbo: {
        ...withPreviousTagIdentities(play, priorCurrent, true),
        credits:
          play.credits == null
            ? play.credits
            : teamIdsOnCredits(play.credits, teams)
      },
      startTime: play.about.startTime ?? null,
      endTime: play.about.endTime ?? null,
      source: system
    }))

    if (system === 'teamstation') {
      const settings = await radarSettings(trx)
      const priorByIndex = new Map(
        priorRows.map(row => [row.atBatIndex, row.gumbo])
      )
      if (priorCurrent != null)
        priorByIndex.set(priorCurrent.about?.atBatIndex ?? -1, priorCurrent)
      const incoming = [...plays.map(p => p.gumbo), currentPlay]
      // History corrections can move an unchanged pitch across at-bats.
      // Keep the full old/new ordering for equal-time batched pitches too.
      const nextByIndex = new Map(live ? priorByIndex : [])
      for (const index of body.remove ?? []) nextByIndex.delete(index)
      if (priorCurrent?.about?.atBatIndex != null)
        nextByIndex.delete(priorCurrent.about.atBatIndex)
      for (const play of incoming)
        if (play != null && typeof play === 'object') {
          const index = (play as Partial<GumboPlay>).about?.atBatIndex
          if (index != null) nextByIndex.set(index, play)
        }
      const ordered = (map: Map<number, unknown>): unknown[] =>
        [...map].sort(([a], [b]) => a - b).map(([, play]) => play)
      const priorHistory = ordered(priorByIndex)
      const nextHistory = ordered(nextByIndex)
      const readings = await radarReadings(trx, gameId, incoming, settings)
      plays = plays.map(p => ({
        ...p,
        gumbo: withRadarSpeeds(
          p.gumbo,
          readings,
          settings,
          priorHistory,
          nextHistory
        )
      }))
      currentPlay = withRadarSpeeds(
        currentPlay,
        readings,
        settings,
        priorHistory,
        nextHistory
      )
      const future = incoming
        .flatMap(radarTargets)
        .filter(t => !t.inPlay)
        .map(t => t.at + settings.pitchWindowSec * 1000 - Date.now())
      const remaining = Math.max(...future)
      if (remaining >= 0)
        refreshDelay = Math.min(remaining, settings.pitchWindowSec * 1000) + 50
      await trx
        .updateTable('games')
        .set({ scoringOwner: 'teamstation' })
        .where('id', '=', gameId)
        .execute()
    }
    // The at-bat in progress is stored as every play is, naming nobody.
    if (currentPlay != null && typeof currentPlay === 'object')
      currentPlay = withoutNames(currentPlay, { source: system })
    const write = {
      gameId,
      homeTeamId: game.home_team_id,
      awayTeamId: game.away_team_id,
      plays
    }
    if (live) {
      await upsertGameEvents(trx, { ...write, remove: body.remove ?? [] })
    } else {
      await replaceGameEvents(trx, write)
    }
    // A live post writes the plays it names and no other, and this one holds
    // the game's row: the rest stand as they were read.
    const stored = live
      ? await playsAfterLivePost(trx, gameId, priorRows, plays, body.remove)
      : await readPlays(trx, gameId)
    const documents = stored.map(documentOf)
    const posted = scoresOf(stored)
    const decision = live
      ? { ingestStatus: 'ok' as const, ingestMessage: null }
      : ingestDecision(
          game.away_score,
          game.home_score,
          posted.away,
          posted.home,
          game.ingest_status,
          game.ingest_message
        )
    // A live post keeps the lineups' digest, and a TeamStation one the
    // teams' default lineups, from what it leaves stored.
    const lineups: {
      lineups_digest?: string
      lineup_started_at?: Date | null
    } = live
      ? await keepLineups(
          trx,
          {
            id: gameId,
            home_team_id: game.home_team_id,
            away_team_id: game.away_team_id,
            lineup_started_at: game.lineup_started_at
          },
          storedLineupGame(stored, currentPlay),
          system === 'teamstation',
          new Date()
        )
      : {}
    const halves = halfOutcomes(documents)
    const { hasStarted } = await trx
      .selectFrom('games')
      .select(
        scoringActivitySql(sql`${JSON.stringify(currentPlay)}::jsonb`).as(
          'hasStarted'
        )
      )
      .where('games.id', '=', gameId)
      .executeTakeFirstOrThrow()
    const status = live
      ? statusAfterLivePost(game.status, stored, hasStarted)
      : statusAfterPost(game.status, posted, hasStarted)
    await trx
      .updateTable('games')
      .set({
        away_score: posted.away,
        home_score: posted.home,
        linescore: lineScore(documents, halves, posted.away, posted.home),
        status:
          game.cancellation_reason === 'withdrawal' ? 'cancelled' : status,
        // A game's first plays fix its fence, so a later season or league
        // change leaves their distances be: the fence the scorer's
        // documents were sized by, when the post says, else the one the
        // game resolves to now.
        ...(stored.length > 0 && !hadPlays
          ? {
              fence_distance_ft: body.fenceDistanceFt ?? resolvedFenceDistance
            }
          : {}),
        ingest_status: decision.ingestStatus,
        ingest_message: decision.ingestMessage,
        ...(live && body.currentPlay !== undefined
          ? atBatWrite(
              stored,
              currentPlay,
              game.pregame,
              // This post finds no play and no at-bat stored: it may begin it.
              priorRows.length === 0 && game.currentPlay == null
            )
          : {}),
        ...lineups,
        updated_at: new Date()
      })
      .where('id', '=', gameId)
      .execute()
    // This post holds the game's row, so unless the repair writes them, its
    // plays are the ones just read.
    const { rewritten } = await repairEventTags(trx, gameId, stored)
    const taggedStored =
      rewritten.length > 0 ? await readPlays(trx, gameId) : stored
    const taggedGame = await trx
      .selectFrom('games')
      .select(['currentPlay', 'pregame', ...LIST_FIELDS])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    const taggedCurrent = atBatOf(taggedGame, taggedStored.length > 0)
    // Before the first pitch a reader is answered the pregame lineups folded
    // into an at-bat, which only a replay after the commit can give.
    const folds =
      taggedStored.length === 0 &&
      taggedGame.currentPlay == null &&
      taggedCurrent != null
    // And to the screens of that game: its event, and home and schedule,
    // announced as this transaction's last statement, when the post changed
    // something a list shows of it. A pitch that moves only the count tells
    // no screen scope: every screen of the game hears it as a play frame.
    // The notice is the post's (`byPost`), which those frames read already.
    // A post that makes the game final, unmakes it, or changes a final score
    // moves its teams' records too, so Home's lists are told; a play
    // otherwise is not.
    const nowStatus =
      game.cancellation_reason === 'withdrawal' ? 'cancelled' : status
    const finalBefore = game.status === 'final'
    const finalNow = nowStatus === 'final'
    if (
      finalBefore !== finalNow ||
      (finalNow &&
        (posted.away !== game.away_score || posted.home !== game.home_score))
    )
      await noteGameFigures(trx, gameId, undefined, { byPost: true })
    else if (
      listFieldsChanged(
        { ...game, currentPlay: atBatOf(game, hadPlays) },
        { ...taggedGame, currentPlay: taggedCurrent }
      )
    )
      noteScopeChange(trx, { gameId, byPost: true })
    const sides = teamsOfRow(game)
    const whole = {
      plays: taggedStored.map(row => row.gumbo as GumboPlay),
      currentPlay: taggedCurrent as CurrentPlay | null
    }
    // What this post wrote: the plays it sent and those its tag repair
    // rewrote; the indexes it took away that it did not write again.
    const edited = new Set([...indexes, ...rewritten])
    const storedAt = new Set(taggedStored.map(row => row.atBatIndex))
    const removed = [...new Set(body.remove ?? [])].filter(
      index => !storedAt.has(index)
    )
    const editsOf = (named: NamedPlays): PlayEdit[] =>
      playEditsOf(taggedStored, named, removed, sides)
    const digests: PostedDigests = {
      lineupsDigest: lineups.lineups_digest ?? game.lineups_digest,
      playsDigest: playsDigest(taggedStored, taggedCurrent),
      priorPlaysDigest: prior,
      generation: game.play_generation
    }
    const senderHalves = (await options.halves?.(trx, game)) ?? []
    // Every viewer of the game may be sent what this post wrote, named as
    // they read it: never with the sender's halves. Not when the game's book
    // is made over other people than before, someone brought in or the last
    // play naming someone taken away, which can change how the book tells
    // others apart on plays it did not write: then viewers read again.
    const told =
      live &&
      !folds &&
      !(await scopeMoved(trx, gameId, {
        before: scopeBefore,
        read: mayMoveScope,
        idsBefore,
        after: whole
      }))
    // Only what this post wrote is named for an edits answer, every play for
    // any other, and in the same pass what it wrote for the public, over the
    // whole game's book.
    const edits = live && options.answer === 'edits'
    const resolved = await resolveScoringPlays(trx, whole, {
      ...(edits ? { only: edited } : {}),
      publicOnly: told ? edited : [],
      halves: senderHalves,
      gameId,
      ...(edits ? {} : { listFullNamesFor: options.listFullNamesFor })
    })
    const answer: PostedPlays | PostedEdits = edits
      ? {
          edits: editsOf(resolved),
          currentPlay: playForWire(resolved.currentPlay, sides),
          ...digests
        }
      : {
          plays: taggedStored.map((row, index) => ({
            ...playJson(row),
            gumbo: playForWire(resolved.plays[index], sides)
          })),
          currentPlay: playForWire(resolved.currentPlay, sides),
          ...digests,
          ...(resolved.readerNames == null
            ? {}
            : { readerNames: resolved.readerNames })
        }
    const everyone = resolved.public
    const shared: PublicPlayEdits | undefined = told
      ? {
          generation: game.play_generation,
          fromDigest: prior,
          digest: digests.playsDigest,
          namesDigest: resolved.namesDigest,
          indexes: taggedStored
            .filter(row => edited.has(row.atBatIndex))
            .map(row => row.atBatIndex),
          removed,
          edits: editsOf(everyone),
          currentPlay: playForWire(everyone.currentPlay, sides)
        }
      : undefined
    // Told to the game socket when this commits: what this post wrote, or,
    // when that cannot be told, that the plays are to be read again. The
    // lineups only when their digest moves from the one the game answered
    // before: the digest is of their stored form, so a pitch leaves it alone
    // and an undone change moves it.
    await notifyPlayEdits(
      trx,
      gameId,
      {
        generation: game.play_generation,
        digest: digests.playsDigest,
        namesDigest: resolved.namesDigest
      },
      shared,
      options
    )
    await notifyGameChange(trx, { game: gameId, kind: 'game' })
    if ('lineups_digest' in lineups && lineups.lineups_digest !== lineupsBefore)
      await notifyGameChange(trx, { game: gameId, kind: 'lineups' })
    await written?.(trx, answer)
    folding = {
      fold: await pregameFold(
        trx,
        gameId,
        { ...game, currentPlay: taggedGame.currentPlay },
        resolved
      ),
      sides
    }
    return answer
  })
    .then(async result => {
      if (refreshDelay != null && !db.isTransaction)
        scheduleRadarRefresh(db, gameId, refreshDelay)
      // Before the first pitch the at-bat is folded as `GET /events` folds
      // it, from what the post read: the replay runs after the commit, or,
      // in a caller's transaction, once this post's part of it is done.
      if (folding != null)
        result.currentPlay = playForWire(await folding.fold(), folding.sides)
      // Every play unless asked for edits, and edits only on a live post.
      return result as PostedAnswer<A>
    })
    .catch((error: unknown) => {
      // Which user a failed post named reads the same in either record.
      throw unknownUser(error, withHalfOuts(sentBody.plays)) ?? error
    })
}

/**
 * Tells the game socket how a post changed the game's plays. A live post that
 * leaves more than the pregame lineups names the digests it took the game
 * between and the indexes it put and took away, and leaves the frame each
 * viewer is sent in Valkey, inside the post's transaction, so a worker
 * delivering the notice reads no play. Any other post, and one that wrote
 * too many plays to name, says only that the plays are to be read again,
 * with the digest it left them at: a screen that holds that digest, as the
 * post's own sender does, has nothing to read. Either names the digest of
 * the book the post named its plays from, which every viewer compares with
 * the one it read.
 */
async function notifyPlayEdits(
  trx: Trx,
  gameId: string,
  left: { generation: number; digest: string | null; namesDigest: string },
  shared: PublicPlayEdits | undefined,
  options: { cache?: ValkeyCache }
): Promise<void> {
  const { generation } = left
  if (
    shared?.fromDigest == null ||
    shared.indexes.length + shared.removed.length > MAX_NOTICE_INDEXES
  ) {
    await notifyGameChange(trx, {
      game: gameId,
      kind: 'playEdits',
      generation,
      ...(left.digest == null ? {} : { digest: left.digest }),
      namesDigest: left.namesDigest
    })
    return
  }
  const notice = {
    game: gameId,
    kind: 'playEdits' as const,
    generation,
    fromDigest: shared.fromDigest,
    digest: shared.digest,
    namesDigest: shared.namesDigest,
    indexes: shared.indexes,
    removed: shared.removed
  }
  const frame: PlayEditsData = {
    generation,
    fromDigest: shared.fromDigest,
    digest: shared.digest,
    namesDigest: shared.namesDigest,
    edits: shared.edits,
    currentPlay: shared.currentPlay
  }
  await options.cache?.set(
    playEditsKey(notice),
    JSON.stringify(frame),
    PLAY_EDITS_TTL_MS
  )
  await notifyGameChange(trx, notice)
}

/**
 * Whether a post left the game's book made over other people than `before`,
 * the scope it found: a newcomer, whose short name can make others' longer,
 * or the last mention of someone gone, whose leaving can make them shorter.
 * With `read` false the post could not move the `event_players`, so only
 * the plays and at-bat are compared; `before` then holds just those, and a
 * change there, which `read` would have foreseen, is a move.
 */
async function scopeMoved(
  trx: Trx,
  gameId: string,
  scope: {
    before: ReadonlySet<number>
    read: boolean
    idsBefore: ReadonlySet<number>
    after: StoredGame
  }
): Promise<boolean> {
  const after = new Set(scoringIdsIn(scope.after))
  if (!scope.read) return !sameIds(scope.idsBefore, after)
  for (const row of (await gamePlayers(trx, [gameId])).get(gameId) ?? [])
    after.add(row.gumboId)
  return !sameIds(scope.before, after)
}

/** Whether two sets of ids hold the same ids. */
function sameIds(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  return a.size === b.size && [...a].every(id => b.has(id))
}

/**
 * The edits that take a game's stored plays to `stored`: a put of each of
 * `named`'s plays as its stored row, named, in index order, then a remove of
 * each index of `removed`.
 */
export function playEditsOf(
  stored: readonly StoredPlay[],
  named: NamedPlays,
  removed: readonly number[],
  sides: ReturnType<typeof teamsOfRow>
): PlayEdit[] {
  const byIndex = new Map(
    named.plays.map(play => [play.about.atBatIndex, play])
  )
  return [
    ...stored
      .filter(row => byIndex.has(row.atBatIndex))
      .map((row): PlayEdit => ({
        op: 'put',
        play: {
          ...playJson(row),
          gumbo: playForWire(byIndex.get(row.atBatIndex), sides)
        }
      })),
    ...removed.map((atBatIndex): PlayEdit => ({ op: 'remove', atBatIndex }))
  ]
}

/**
 * A play TeamStation scored is replayed from its record, of version 1, 2 or
 * 3: a record in any other version would be dropped when the game is read
 * back. A play with no record is read from its document.
 */
function readableVersion(play: object): boolean {
  const record = (play as { teamStation?: unknown }).teamStation
  if (record == null) return true
  const version =
    typeof record === 'object'
      ? (record as { version?: unknown }).version
      : undefined
  return (
    (version === 1 || version === 2 || version === 3) &&
    storedRecordOf(play) != null
  )
}

/**
 * A play naming a user who does not exist fails on a foreign key inside the
 * trigger that copies the play out: `eventCredits` for a credit, and
 * `event_players` for the batter, the pitcher or a runner. That is the
 * caller's mistake, not the server's, so it answers 400 naming the play and
 * the user rather than a 500.
 */
export function unknownUser(
  error: unknown,
  plays: GumboPlay[]
): Error | undefined {
  if (error == null || typeof error !== 'object') return
  const { code, table, detail } = error as {
    code?: unknown
    table?: unknown
    detail?: unknown
  }
  if (code !== '23503') return
  // Postgres says which key was missing: `Key (creditGumboId)=(7) is not
  // present in table "gumbo_ids".`
  const key = (column: string): number | undefined => {
    const match = new RegExp(`^Key \\(${column}\\)=\\((\\d+)\\)`).exec(
      typeof detail === 'string' ? detail : ''
    )
    return match == null ? undefined : Number(match[1])
  }
  if (table === 'eventCredits') {
    const userId = key('creditGumboId')
    const credited = plays.find(
      play =>
        play.credits?.some(credit => credit.creditUserId === userId) === true
    )
    if (userId == null || credited == null) {
      return badRequest('A credit names a user who does not exist')
    }
    return badRequest(
      `play ${credited.about.atBatIndex} credits user ${userId}, who does not exist`
    )
  }
  if (table === 'event_players') {
    const userId = key('gumbo_id')
    if (userId == null) return
    const named = plays.find(play => playerIds(play).includes(userId))
    if (named == null) {
      return badRequest(`A play names user ${userId}, who does not exist`)
    }
    return badRequest(
      `play ${named.about.atBatIndex} names user ${userId}, who does not exist`
    )
  }
}

/** The users the trigger copies into `event_players` from one play. */
function playerIds(play: GumboPlay): Array<number | null | undefined> {
  return [
    play.matchup?.batter?.id,
    play.matchup?.pitcher?.id,
    ...(play.runners ?? []).map(runner => runner.details?.runner?.id)
  ]
}

const PLAY_COLUMNS = [
  'id',
  'gameId',
  'atBatIndex',
  'inning',
  'halfInning',
  'eventType',
  'awayScore',
  'homeScore',
  'gumbo'
] as const

export type StoredPlay = Pick<
  Selectable<EventsTable>,
  (typeof PLAY_COLUMNS)[number]
>

/**
 * A game's stored plays in index order, with the columns the line score and
 * the halves are worked out from.
 */
export async function readPlays(
  db: Trx,
  gameId: string
): Promise<StoredPlay[]> {
  return await db
    .selectFrom('events')
    .select(PLAY_COLUMNS)
    .where('gameId', '=', gameId)
    .orderBy('atBatIndex')
    .execute()
}

/**
 * A game's stored plays after a live post, reading again only those it wrote:
 * in a long game the rest are most of what the post would otherwise read, and
 * the documents kept need nothing worked out from them again.
 */
async function playsAfterLivePost(
  db: Trx,
  gameId: string,
  prior: StoredPlay[],
  written: PlayWrite[],
  removed: readonly number[] = []
): Promise<StoredPlay[]> {
  const indexes = written.map(play => play.gumbo.about.atBatIndex)
  const gone = new Set([...indexes, ...removed])
  const rewritten =
    indexes.length === 0
      ? []
      : await db
          .selectFrom('events')
          .select(PLAY_COLUMNS)
          .where('gameId', '=', gameId)
          .where('atBatIndex', 'in', indexes)
          .execute()
  return [...prior.filter(row => !gone.has(row.atBatIndex)), ...rewritten].sort(
    (a, b) => a.atBatIndex - b.atBatIndex
  )
}

/**
 * What a live post that sends the at-bat in progress stores of it, in its
 * stored form, as the pregame is (`withoutNames`). Before
 * the first pitch no Gumbo is: a post that leaves no stored play, and whose
 * at-bat holds lineup changes only, keeps its record as the game's pregame
 * lineups, as does the post that takes the first pitch back. The first post
 * past them (`begins`) stores the at-bat, and keeps the lineups it began
 * from as the pregame: what was saved before, and any lineup change it
 * carries ahead of the first pitch. A later post keeps the pregame as it is,
 * or fills it when none was kept. A post that clears a game of plays and
 * at-bat alike clears its pregame too.
 */
function atBatWrite(
  stored: Array<{ gumbo: unknown }>,
  currentPlay: unknown,
  pregame: unknown,
  begins: boolean
): { currentPlay: unknown; pregame?: unknown } {
  if (stored.length === 0 && currentPlay == null)
    return { currentPlay: null, pregame: null }
  if (
    stored.length === 0 &&
    currentPlay != null &&
    storedRecordOf(currentPlay) != null &&
    pregameRecord(currentPlay)
  )
    return {
      currentPlay: null,
      pregame: withoutNames(
        (currentPlay as { teamStation: unknown }).teamStation
      )
    }
  const began =
    pregame == null || begins
      ? lineupsBefore(
          [...stored.map(row => row.gumbo), currentPlay].find(
            play => storedRecordOf(play) != null
          )
        )
      : null
  return {
    currentPlay,
    ...(began == null ? {} : { pregame: withoutNames(began) })
  }
}

/**
 * The lineups a record began from: its setup and the lineup changes before
 * its first other action, with their times. Null without a record.
 */
export function lineupsBefore(play: unknown): unknown {
  const raw = (play as { teamStation?: Record<string, unknown> } | undefined)
    ?.teamStation
  const actions = Array.isArray(raw?.actions) ? raw.actions : null
  if (raw == null || actions == null) return null
  const first = actions.findIndex(
    action => (action as { type?: unknown }).type !== 'lineup'
  )
  const count = first < 0 ? actions.length : first
  const { playbackTimes: _playback, detail: _detail, ...kept } = raw
  const lineups: Record<string, unknown> = {
    ...kept,
    actions: actions.slice(0, count),
    ...(Array.isArray(raw.actionTimes)
      ? { actionTimes: raw.actionTimes.slice(0, count) }
      : {})
  }
  return lineups
}

export function playJson(row: StoredPlay): {
  id: string
  gameId: string
  gumbo: unknown
} {
  return { id: row.id, gameId: row.gameId, gumbo: row.gumbo }
}

/**
 * A sha256 of a game's stored plays, in index order, and its at-bat in
 * progress: the same for the same stored game, wherever it is read.
 */
export function playsDigest(
  rows: Array<{ gumbo: unknown }>,
  currentPlay: unknown
): string {
  return createHash('sha256')
    .update(JSON.stringify([rows.map(row => row.gumbo), currentPlay ?? null]))
    .digest('hex')
}

/**
 * The digest of a game's plays as `GET /games/:gameId/events` gives it, read
 * through `db`: what a reset is confirmed against.
 */
export async function gamePlaysDigest(
  db: Trx,
  game: { id: string; currentPlay: unknown; pregame: unknown }
): Promise<string> {
  const rows = await readPlays(db, game.id)
  return playsDigest(rows, atBatOf(game, rows.length > 0))
}

/** The columns of a game that a list of games shows, beside its at-bat. */
const LIST_FIELDS = [
  'status',
  'away_score',
  'home_score',
  'linescore',
  'start_at',
  'home_team_id',
  'away_team_id',
  'venue',
  'field_id',
  'cancellation_reason'
] as const

/** A game as a list shows it: `LIST_FIELDS` and the at-bat readers get. */
export interface ListFields {
  status: string
  away_score: number | null
  home_score: number | null
  linescore: unknown
  currentPlay: unknown
  start_at: Date
  home_team_id: string
  away_team_id: string
  venue: string | null
  field_id: string | null
  cancellation_reason: string | null
}

/**
 * Whether a list of games shows `after` differently from `before`: its
 * status, score, inning or half, start, teams, venue or field, or why it was
 * cancelled. The inning and half are the at-bat's and the line score's
 * halves; a pitch, a count or a hit changes none of these.
 */
export function listFieldsChanged(
  before: ListFields,
  after: ListFields
): boolean {
  return (
    before.status !== after.status ||
    before.away_score !== after.away_score ||
    before.home_score !== after.home_score ||
    halfOf(before) !== halfOf(after) ||
    new Date(before.start_at).getTime() !==
      new Date(after.start_at).getTime() ||
    before.home_team_id !== after.home_team_id ||
    before.away_team_id !== after.away_team_id ||
    before.venue !== after.venue ||
    before.field_id !== after.field_id ||
    before.cancellation_reason !== after.cancellation_reason
  )
}

/**
 * The half a game is in, as its at-bat and its line score place it: the
 * line score's innings, and whether the last has had its bottom half. A game
 * with no at-bat yet is where its first will be, the top of the 1st.
 */
function halfOf(game: Pick<ListFields, 'linescore' | 'currentPlay'>): string {
  const innings =
    (game.linescore as { innings?: unknown[] } | null)?.innings ?? []
  const last = innings.at(-1) as { home?: { runs?: unknown } } | undefined
  const about = (
    game.currentPlay as {
      about?: { inning?: unknown; isTopInning?: unknown }
    } | null
  )?.about
  return JSON.stringify([
    innings.length,
    last?.home?.runs != null,
    about?.inning ?? PREGAME_ABOUT.inning,
    about?.isTopInning ?? PREGAME_ABOUT.isTopInning
  ])
}

/**
 * The game's score is the last one any play carries. A play that carries none,
 * such as a stolen base written without the score, does not wipe it out.
 */
function scoresOf(rows: StoredPlay[]): {
  away: number | null
  home: number | null
} {
  let away: number | null = null
  let home: number | null = null
  for (const row of rows) {
    away = row.awayScore ?? away
    home = row.homeScore ?? home
  }
  return { away, home }
}

/**
 * A cancelled game stays cancelled, whatever is posted to it: plays with
 * scores must not bring it back as a finished game. Otherwise a post that
 * leaves both teams' scores makes the game final. Otherwise a surviving pitch
 * or ball in play is required for an unfinished game to be under way.
 */
export function statusAfterPost(
  status: 'scheduled' | 'inProgress' | 'final' | 'cancelled',
  posted: { away: number | null; home: number | null },
  hasStarted: boolean
): 'scheduled' | 'inProgress' | 'final' | 'cancelled' {
  if (status === 'cancelled') return status
  if (posted.away != null && posted.home != null) return 'final'
  if (status === 'final') return status
  return hasStarted ? 'inProgress' : 'scheduled'
}

/**
 * After a live post the stored plays decide: a cancelled game stays
 * cancelled, a stored `final_score` makes it final, and a surviving pitch or
 * ball in play makes it under way. Undoing all such activity returns to scheduled.
 */
export function statusAfterLivePost(
  status: 'scheduled' | 'inProgress' | 'final' | 'cancelled',
  stored: Array<{ eventType: string | null }>,
  hasStarted: boolean
): 'scheduled' | 'inProgress' | 'final' | 'cancelled' {
  if (status === 'cancelled') return status
  if (stored.some(play => play.eventType === 'final_score')) return 'final'
  return hasStarted ? 'inProgress' : 'scheduled'
}

/** A stored row's document, which the line score is worked out from. */
export function documentOf(row: StoredPlay): GumboPlay {
  return row.gumbo as GumboPlay
}

/**
 * Keep a matching stored score's status, including `scoreMismatch`. A null
 * stored score has nothing to compare. Two stored numbers that the post
 * disagrees with become `scoreMismatch`.
 */
function ingestDecision(
  storedAway: number | null,
  storedHome: number | null,
  postedAway: number | null,
  postedHome: number | null,
  ingestStatus: 'none' | 'ok' | 'scoreMismatch' | 'error',
  ingestMessage: string | null
): {
  ingestStatus: 'none' | 'ok' | 'scoreMismatch' | 'error'
  ingestMessage: string | null
} {
  if (postedAway === storedAway && postedHome === storedHome) {
    return { ingestStatus, ingestMessage }
  }
  if (storedAway == null || storedHome == null) {
    return { ingestStatus: 'ok', ingestMessage: null }
  }
  return {
    ingestStatus: 'scoreMismatch',
    ingestMessage: `Posted ${postedAway ?? '?'}-${postedHome ?? '?'}, stored ${storedAway}-${storedHome}`
  }
}
