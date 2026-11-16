import { isDeepStrictEqual } from 'node:util'

import { captureException } from '@sentry/node'
import type { Kysely } from 'kysely'
import { DatabaseError } from 'pg'

import type { GumboPlay } from '../../common/gumboPlay'
import { teamStationOf } from '../../common/scoring/document'
import { storedRecordOf } from '../../common/scoring/gumbo'
import {
  type ImportedRecords,
  importedRecords,
  importedSetup
} from '../../common/scoring/importedRecord'
import type { RosterPlayer } from '../../common/scoring/lineup'
import {
  radarTargets,
  withRadarSpeedsKeepingOwn
} from '../../common/scoring/radarSpeeds'
import type { GameTeam, Side } from '../../common/scoring/state'
import { storedForm, withNames } from '../../common/scoring/storedNames'
import type { Database } from '../db/database'
import { radarSettings } from '../nodeSettings'
import { resolveScoringGame } from '../scoring/openRow'
import { ScoringProjectionConflict } from '../scoring/projection'
import { gameNames, gamePlayers } from '../users/nameBook'
import { radarReadings } from './radarSpeeds'

/**
 * The records a game's plays are given when they came without one, written
 * where the plays are stored. Every writer of plays calls this after its own
 * writes, inside its transaction and with the game's row locked: a post, the
 * importer's `PATCH` of events, and the conversion of stored games.
 *
 * A game TeamStation owns (`scoringOwner = 'teamstation'`) is left as its
 * scorers saved it, records and all; a play an import left there with none
 * is read from its document, as before the scorer took over. On any other
 * game nothing was scored in TeamStation — its first TeamStation post takes
 * it over — so every record on it was built here, and each is built again
 * from the plays as they now stand.
 */

/** What a write of plays says of their records, as its answer gives it. */
export interface ImportedCounts {
  /** Plays the game stores. */
  plays: number
  /** Pitch events in them. */
  pitches: number
  /** Plays holding a record once the write is done. */
  records: number
  /** Plays whose record needed a correction the events did not give. */
  corrections: number
  /**
   * Why the game has no records, when it has none. `unreadable` is a game
   * whose records would not read, or whose plays the converter failed on.
   */
  unconvertible?: 'unnamedPlayers' | 'noPlayByPlay' | 'unreadable'
}

export interface ImportedWrite {
  counts: ImportedCounts
  /** The plays given a new or rebuilt record, by index. */
  rewritten: number[]
  /**
   * When the radar's readings for the rewritten plays' last pitch may still
   * come, in ms from now: the post schedules its refresh for them then.
   */
  radarDelay?: number
}

interface GameRow {
  id: string
  home_team_id: string
  away_team_id: string
  status: string
  scoringOwner: string | null
}

type Json = Record<string, unknown>

function withoutRecord(gumbo: Json): Json {
  const { teamStation: _record, ...rest } = gumbo
  return rest
}

function pitchesIn(plays: readonly Json[]): number {
  let pitches = 0
  for (const play of plays) {
    const events: unknown = play.playEvents
    if (Array.isArray(events))
      pitches += events.filter(
        event => (event as { isPitch?: unknown } | null)?.isPitch === true
      ).length
  }
  return pitches
}

/**
 * Gives the game's plays their records, and answers what they hold. `game`
 * is the locked row as the caller holds it, its owner as it now stands.
 */
export async function writeImportedRecords(
  trx: Kysely<Database>,
  game: GameRow,
  options: {
    /**
     * Build every play's record again: a write that changed plays which
     * already had one. Without it, a post that only adds plays converts
     * those, from where the plays before them left the game.
     */
    rebuild: boolean
  } = { rebuild: true }
): Promise<ImportedWrite> {
  const rows = await trx
    .selectFrom('events')
    .select(['id', 'atBatIndex', 'gumbo'])
    .where('gameId', '=', game.id)
    .orderBy('atBatIndex')
    .execute()
  const owned = game.scoringOwner === 'teamstation'
  const stored = rows.map(row => row.gumbo as Json)
  const recorded = stored.filter(play => storedRecordOf(play) != null).length
  const counts = (
    records: number,
    corrections = 0,
    unconvertible?: ImportedCounts['unconvertible']
  ): ImportedCounts => ({
    plays: rows.length,
    pitches: pitchesIn(stored),
    records,
    corrections,
    ...(unconvertible == null ? {} : { unconvertible })
  })
  // A game TeamStation owns keeps what its scorers saved: a play it holds
  // with no record is an import the scorer took over from, and stays read
  // from its document.
  if (owned) return { counts: counts(recorded), rewritten: [] }
  // The plays without the records built for them before, or as they stand
  // when only new plays are to be converted.
  const plays = (options.rebuild
    ? stored.map(withoutRecord)
    : stored) as unknown as GumboPlay[]
  const teams: Record<Side, GameTeam> = {
    away: { id: game.away_team_id, name: '', logoUrl: null },
    home: { id: game.home_team_id, name: '', logoUrl: null }
  }
  // In a fixed order: the rows come back in no order, and the trigger that
  // keeps them writes them again with every write of a play, so the same
  // plays would otherwise give their setup its players in another order.
  const players = [
    ...((await gamePlayers(trx, [game.id])).get(game.id) ?? [])
  ].sort((a, b) =>
    a.gumboId !== b.gumboId
      ? a.gumboId - b.gumboId
      : String(a.teamId).localeCompare(String(b.teamId))
  )
  const rosters: Record<Side, RosterPlayer[]> = { away: [], home: [] }
  for (const player of players) {
    const side =
      player.teamId === game.home_team_id
        ? 'home'
        : player.teamId === game.away_team_id
          ? 'away'
          : null
    if (side != null)
      rosters[side].push({ gumboId: player.gumboId, shortName: '' })
  }
  const book = (await gameNames(trx, [game.id])).get(game.id)
  const nameOf = (id: number): string | undefined => book?.nameOf(id)
  const writes: Array<{ id: string; index: number; gumbo: Json }> = []
  // A game whose records cannot be built has none of the ones built before,
  // however the write came: a post that only adds plays included.
  const withNone = (): Json[] => stored.map(withoutRecord)
  // A game the scoring screen could not read with its records, or whose
  // plays the converter fails on anywhere — building their records, storing
  // them, or replaying them — is left readable from its documents, and the
  // post goes through. Only a database error stops the write.
  let unreadable = false
  let converted: ImportedRecords = { records: new Map(), corrections: [] }
  let built: Json[]
  try {
    converted = importedRecords(
      {
        plays,
        currentPlay: null
      },
      {
        gamePk: game.id,
        teams,
        setup: importedSetup(plays, rosters, teams),
        final: game.status === 'final'
      }
    )
    built =
      converted.unconvertible != null
        ? withNone()
        : rows.map((row, index) => {
            const play = plays[index] as unknown as Json
            const record = converted.records.get(row.atBatIndex)
            return record == null
              ? play
              : storedConvertedPlay(play, record, teams, nameOf)
          })
    if (converted.records.size > 0)
      await resolveScoringGame(
        trx,
        { plays: built as unknown as GumboPlay[], currentPlay: null },
        { gameId: game.id }
      )
  } catch (error) {
    if (error instanceof DatabaseError) throw error
    // Two merged accounts on opposite sides are a known way not to read;
    // anything else is a converter failure, and is reported.
    if (!(error instanceof ScoringProjectionConflict)) {
      console.error(`imported records of ${game.id}: ${String(error)}`)
      captureException(error)
    }
    unreadable = true
    built = withNone()
  }
  // Their pitches take the radar's speeds, as a TeamStation post's do: the
  // radar reads the times their records give. A pitch it has no reading for
  // keeps the speeds the outside scorer recorded.
  let radarDelay: number | undefined
  if (
    !unreadable &&
    converted.records.size > 0 &&
    rows.some((row, index) => !isDeepStrictEqual(built[index], stored[index]))
  ) {
    const settings = await radarSettings(trx)
    const readings = await radarReadings(trx, game.id, built, settings)
    if (readings.length > 0)
      built = built.map((gumbo, index) =>
        withRadarSpeedsKeepingOwn(
          gumbo,
          readings,
          settings,
          stored[index],
          built
        )
      )
    const future = built
      .flatMap(radarTargets)
      .filter(target => !target.inPlay)
      .map(target => target.at + settings.pitchWindowSec * 1000 - Date.now())
    const remaining = Math.max(...future)
    if (remaining >= 0)
      radarDelay = Math.min(remaining, settings.pitchWindowSec * 1000) + 50
  }
  for (const [index, row] of rows.entries()) {
    const gumbo = built[index]
    // A play whose record comes out as it was is left as stored.
    if (isDeepStrictEqual(gumbo, stored[index])) continue
    writes.push({ id: row.id, index: row.atBatIndex, gumbo })
  }
  for (const write of writes)
    await trx
      .updateTable('events')
      .set({ gumbo: write.gumbo, updatedAt: new Date() })
      .where('id', '=', write.id)
      .execute()
  const records =
    unreadable || converted.unconvertible != null
      ? 0
      : options.rebuild
        ? converted.records.size
        : recorded + converted.records.size
  return {
    counts: counts(
      records,
      unreadable ? 0 : converted.corrections.length,
      unreadable ? 'unreadable' : converted.unconvertible
    ),
    rewritten: writes.map(write => write.index),
    ...(radarDelay == null ? {} : { radarDelay })
  }
}

/**
 * A converted play as it is stored: named first, so that the sentences of
 * its events are read from the names in their words; its record, by team,
 * beside it; then stored as TeamStation's own play is, which takes every name
 * out again. A description no sentence reproduces is kept, marked `said:
 * null`, so no later read words it anew.
 */
export function storedConvertedPlay(
  play: Json,
  record: Parameters<typeof teamStationOf>[1],
  teams: Record<Side, GameTeam>,
  nameOf: (id: number) => string | undefined
): Json {
  const named = withNames(play, nameOf)
  const withRecord = { ...named, teamStation: teamStationOf(teams, record) }
  return storedForm(withRecord, { source: 'teamstation', keepWords: true })
    .document
}
