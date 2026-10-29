import { createHash } from 'node:crypto'

import { type Kysely, sql } from 'kysely'

import { notFound } from '../../common/errors'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { narrateTimeline, type Narration } from '../../common/replay/narration'
import {
  type ReplayTimeline,
  replayTimelineOf
} from '../../common/replay/replayTimeline'
import type { StoredGame } from '../../common/scoring/session'
import type { Database } from '../db/database'
import { readPlays } from '../events/postPlays'
import { resolveScoringGame } from '../scoring/openRow'
import { contextOf, contextParts } from '../scoring/replayContext'
import { gameNamesDigest } from '../users/nameBook'
import { type SpeechSettings, synthesize } from './speech'

/**
 * The announcer's audio for one step of a game's replay. The sentence is
 * written here from the game's stored plays, never taken from a caller, so
 * this can speak nothing but a game's own play-by-play. Each sentence is
 * spoken once: its audio is kept by the digest of the voice and the words,
 * and every game that says it again is served the same row.
 */

export interface NarrationAudio {
  digest: string
  text: string
  audio: Buffer
}

const CACHE_SIZE = 200

interface Narrated {
  timeline: ReplayTimeline | null
  narrations: Map<string, Narration>
}

/** Each game's timeline and narrations, by the digest of what they read. */
const timelines = new Map<string, Narrated>()
/** Sentences being spoken now, so two asks for one share the request. */
const speaking = new Map<string, Promise<Buffer>>()

function digestOf(...parts: unknown[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(JSON.stringify(part)).update('\n')
  return hash.digest('hex')
}

/** Every step's sentence for the game as it is stored now. */
export async function narrationsFor(
  db: Kysely<Database>,
  gameId: string
): Promise<Map<string, Narration>> {
  return (await narrated(db, gameId)).narrations
}

/**
 * The game's timeline and every step's sentence, as it is stored now. They
 * are kept by what they read: a digest the database works out of the plays,
 * the at-bat in progress, both teams, the fence and the names of the game's
 * players (`gameNames`). So a sentence already written reads no play, and a
 * renamed team or player is named anew.
 */
async function narrated(
  db: Kysely<Database>,
  gameId: string
): Promise<Narrated> {
  const game = await db
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id', 'currentPlay'])
    .where('id', '=', gameId)
    .executeTakeFirst()
  if (game == null) throw notFound()
  const { plays } = await db
    .selectFrom('events')
    .select(
      sql<
        string | null
      >`md5(string_agg(md5(gumbo::text), ',' order by "atBatIndex"))`.as(
        'plays'
      )
    )
    .where('gameId', '=', gameId)
    .executeTakeFirstOrThrow()
  const currentPlay = (game.currentPlay ?? null) as CurrentPlay | null
  const parts = await contextParts(db, gameId, game)
  const key = `${gameId}:${digestOf(
    plays,
    currentPlay,
    parts,
    await gameNamesDigest(db, gameId)
  )}`
  const cached = timelines.get(key)
  if (cached != null) {
    timelines.delete(key)
    timelines.set(key, cached)
    return cached
  }
  const rows = await readPlays(db, gameId)
  // Spoken with the names the game's players have now.
  const stored: StoredGame = await resolveScoringGame(
    db,
    { plays: rows.map(row => row.gumbo as GumboPlay), currentPlay },
    { gameId }
  )
  const context = await contextOf(db, gameId, game, stored, parts)
  const timeline = context == null ? null : replayTimelineOf(stored, context)
  const made: Narrated = {
    timeline,
    narrations:
      timeline == null
        ? new Map<string, Narration>()
        : narrateTimeline(timeline)
  }
  timelines.set(key, made)
  while (timelines.size > CACHE_SIZE) {
    const oldest = timelines.keys().next().value
    if (oldest == null) break
    timelines.delete(oldest)
  }
  return made
}

/**
 * A step's sentence as the step stood with `count` actions, which is the
 * sentence a viewer who queued it then has on the card: the step cut to
 * those actions, and nothing after it. The game as it stands for a count at
 * or past the step's own, or none.
 */
function sentenceAt(
  { timeline, narrations }: Narrated,
  stepKey: string,
  count: number | undefined
): Narration | undefined {
  const index = timeline?.steps.findIndex(step => step.key === stepKey) ?? -1
  if (timeline == null || index < 0) return narrations.get(stepKey)
  const step = timeline.steps[index]
  if (count == null || count >= step.actions.length)
    return narrations.get(stepKey)
  return narrateTimeline({
    ...timeline,
    steps: [
      ...timeline.steps.slice(0, index),
      { ...step, actions: step.actions.slice(0, count) }
    ]
  }).get(stepKey)
}

/** The digest an announcer's sentence is kept by. */
export function sentenceDigest(
  narration: Narration,
  settings: Pick<SpeechSettings, 'voice' | 'speed'>
): string {
  return digestOf(
    settings.voice,
    settings.speed,
    narration.emphasis,
    narration.text
  )
}

/**
 * The audio of one step's sentence: read back when any game has said it
 * before, spoken and kept when not. 404 for a step the game does not have
 * or one with nothing to say; `SpeechUnavailable` when speech fails, and
 * nothing is kept then.
 */
export async function narrationFor(
  db: Kysely<Database>,
  gameId: string,
  stepKey: string,
  settings: SpeechSettings,
  fetchImpl: typeof fetch = fetch,
  /** How many of the step's actions the sentence is for; all when absent. */
  count?: number
): Promise<NarrationAudio> {
  const narration = sentenceAt(await narrated(db, gameId), stepKey, count)
  if (narration == null || narration.text === '') throw notFound()
  const digest = sentenceDigest(narration, settings)
  const kept = await db
    .selectFrom('narration_audio')
    .select('audio')
    .where('digest', '=', digest)
    .executeTakeFirst()
  if (kept != null) return { digest, text: narration.text, audio: kept.audio }
  let pending = speaking.get(digest)
  if (pending == null) {
    pending = synthesize(narration, settings, fetchImpl).then(async audio => {
      await db
        .insertInto('narration_audio')
        .values({ digest, text: narration.text, voice: settings.voice, audio })
        .onConflict(oc => oc.column('digest').doNothing())
        .execute()
      return audio
    })
    speaking.set(digest, pending)
    pending
      .finally(() => {
        speaking.delete(digest)
      })
      .catch(() => undefined)
  }
  return { digest, text: narration.text, audio: await pending }
}

/** Forgets every cached timeline, for tests. */
export function forgetNarrations(): void {
  timelines.clear()
}
