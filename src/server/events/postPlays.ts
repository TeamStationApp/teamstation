import { createHash } from 'node:crypto'

import { type Kysely, type Selectable, sql, type Transaction } from 'kysely'

import { badRequest, conflict, notFound } from '../../common/errors'
import { withPreviousTagIdentities } from '../../common/eventTags'
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
import { pregameRecord } from '../../common/scoring/sideSwap'
import { withoutNames } from '../../common/scoring/storedNames'
import { teamsOfRow } from '../../common/teamLists'
import { lockPlayerEdits } from '../admin/people'
import { atomic } from '../db/atomic'
import type { Database, EventsTable } from '../db/database'
import { resolvedFenceDistance } from '../games/fenceDistance'
import { scoringActivitySql } from '../games/scoringActivity'
import { radarSettings } from '../nodeSettings'
import { assertStoredScoringRoles } from '../scoring/mergeConflicts'
import { resolveScoringGame } from '../scoring/openRow'
import { contextOf } from '../scoring/replayContext'
import { assertAuthoredRosters } from '../scoring/rosterWrites'
import { notifyGameChange } from '../socket/gameChanges'
import { noteGameFigures, noteScopeChange } from '../socket/syncRevision'
import { atBatOf, postedAtBat } from './atBatInProgress'
import { pregameFold } from './currentPlay'
import { reconcileEventTags } from './eventTags'
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

export interface PostedPlays {
  plays: Array<{ id: string; gameId: string; gumbo: unknown }>
  currentPlay: unknown
  /**
   * The digest the game keeps of its lineups once this post is written, read
   * in its transaction: the base a sender's next live post names. Null only
   * for a replace post to a game no live post has written.
   */
  lineupsDigest: string | null
  /**
   * A digest of the stored plays and the at-bat in progress once this post
   * is written, as `GET /events` and the game socket's `plays` give it.
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
 * answer last, in the post's transaction, before the clock: where a queued
 * post's `Idempotency-Key` keeps it. It sees a pregame at-bat as stored,
 * since the answer folds it only after the commit.
 */
export async function postGamePlays(
  db: Kysely<Database>,
  gameId: string,
  sentBody: PostEventsBody,
  authorize?: (trx: Trx, game: PostedGame) => Promise<void>,
  written?: (trx: Transaction<Database>, posted: PostedPlays) => Promise<void>,
  options: PostOptions = {}
): Promise<PostedPlays> {
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

  return await atomic(db, async (trx): Promise<PostedPlays> => {
    await lockPlayerEdits(trx)
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
        'play_generation'
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
    if (
      [...next.plays, next.currentPlay].some(
        play => storedRecordOf(play) != null
      )
    ) {
      const projected = await resolveScoringGame(trx, next, { gameId })
      await assertStoredScoringRoles(
        trx,
        { id: gameId, ...game },
        next,
        projected
      )
      const context = (await contextOf(trx, gameId, game, projected))!
      assertAuthoredRosters(
        await resolveScoringGame(trx, previous, { gameId }),
        projected,
        context
      )
    } else await assertStoredScoringRoles(trx, { id: gameId, ...game }, next)

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
    const stored = await readPlays(trx, gameId)
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
    await reconcileEventTags(trx, gameId)
    const taggedStored = await readPlays(trx, gameId)
    const taggedGame = await trx
      .selectFrom('games')
      .select(['currentPlay', 'pregame'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    const taggedCurrent = atBatOf(taggedGame, taggedStored.length > 0)
    // Told to the game socket when this commits. The lineups only when their
    // digest moves from the one the game answered before: the digest is of
    // their stored form, so a pitch leaves it alone and an undone change
    // moves it.
    await notifyGameChange(trx, { game: gameId, kind: 'plays' })
    await notifyGameChange(trx, { game: gameId, kind: 'game' })
    if ('lineups_digest' in lineups && lineups.lineups_digest !== lineupsBefore)
      await notifyGameChange(trx, { game: gameId, kind: 'lineups' })
    // And to the screens of that game: its event, and home and schedule,
    // from the clock this transaction bumps last. A post that makes the
    // game final, unmakes it, or changes a final score moves its teams'
    // records too, so Home's lists are told; a play otherwise is not.
    const nowStatus =
      game.cancellation_reason === 'withdrawal' ? 'cancelled' : status
    const finalBefore = game.status === 'final'
    const finalNow = nowStatus === 'final'
    if (
      finalBefore !== finalNow ||
      (finalNow &&
        (posted.away !== game.away_score || posted.home !== game.home_score))
    )
      await noteGameFigures(trx, gameId)
    else noteScopeChange(trx, { gameId })
    const resolved = await resolveScoringGame(
      trx,
      {
        plays: taggedStored.map(row => row.gumbo as GumboPlay),
        currentPlay: taggedCurrent as CurrentPlay | null
      },
      { halves: (await options.halves?.(trx, game)) ?? [], gameId }
    )
    const sides = teamsOfRow(game)
    const answer: PostedPlays = {
      plays: taggedStored.map((row, index) => ({
        ...playJson(row),
        gumbo: playForWire(resolved.plays[index], sides)
      })),
      currentPlay: playForWire(resolved.currentPlay, sides),
      lineupsDigest: lineups.lineups_digest ?? game.lineups_digest,
      playsDigest: playsDigest(taggedStored, taggedCurrent),
      priorPlaysDigest: prior,
      generation: game.play_generation
    }
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
      return result
    })
    .catch((error: unknown) => {
      // Which user a failed post named reads the same in either record.
      throw unknownUser(error, withHalfOuts(sentBody.plays)) ?? error
    })
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

type StoredPlay = Pick<Selectable<EventsTable>, (typeof PLAY_COLUMNS)[number]>

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
