import { asArray, asNumber, asObject, asUnknown } from 'cleaners'
import type { Kysely } from 'kysely'

import { badRequest, conflict, notFound } from '../../common/errors'
import { gumboViolations } from '../../common/gumbo/validate'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { lockPlayerEdits } from '../admin/people'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { assertStoredScoringRoles } from '../scoring/mergeConflicts'
import { notifyGameChange } from '../socket/gameChanges'
import { withoutDescriptions } from './eventWrite'

/**
 * The body of `PATCH /games/:gameId/events`: for plays a game already has,
 * by `atBatIndex`, every event on each (each pitch, ball in play, base-running
 * and line-up event) with the time it was tapped.
 */
export const asPlayEventsBody = asObject({
  plays: asArray(
    asObject({
      atBatIndex: asNumber,
      playEvents: asArray(asUnknown)
    })
  )
})
export type PlayEventsBody = ReturnType<typeof asPlayEventsBody>

export interface AddedPlayEvents {
  plays: number
  events: number
}

/** An instant as the API writes one: an ISO 8601 date-time with its zone. */
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** Whether an event carries its time, as the API writes one. */
function timed(event: unknown): boolean {
  const startTime = (event as { startTime?: unknown } | null)?.startTime
  return (
    typeof startTime === 'string' &&
    ISO_TIME.test(startTime) &&
    Number.isFinite(Date.parse(startTime))
  )
}

/**
 * The people a play event names: its player, pitcher and replaced player, and
 * the runners on base (`offense.first`, `second`, `third`). Anybody else an
 * event may carry, an umpire, is not one of the game's people.
 */
function peopleIn(event: unknown): unknown[] {
  if (event == null || typeof event !== 'object') return []
  const record = event as Record<string, unknown>
  const offense = (record.offense ?? {}) as Record<string, unknown>
  return [
    record.player,
    record.pitcher,
    record.replacedPlayer,
    offense.first,
    offense.second,
    offense.third
  ].flatMap(person => {
    // Nobody named (no id, or null) is fine; any id given is checked.
    const id = (person as { id?: unknown } | null)?.id
    return id == null ? [] : [id]
  })
}

/** A user's id as the statistics rebuild takes one (`gumboStats`). */
function isUserId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0
}

/**
 * Puts each play's events, with their times, on a game an outside scorer
 * scored: the plays an import stored before it kept them. Nothing else about
 * a play is written: its type, time, score, people, runners, credits and
 * highlight stay as stored, and so does the game's status. The game's board
 * then steps at every event.
 *
 * What is worked out from the events follows them the next time it is worked
 * out, and not before: no statistics rebuild is asked for here, and the
 * stored statistics stand until one runs (a later post, or `stats-request`).
 * A rebuild then counts pitches, called third strikes, wild pitches and
 * balks, and credits a pitcher who threw a pitch but faced nobody, from the
 * events. Event tags are matched to the events the next time the game's
 * plays are read (`reconcileEventTags`).
 *
 * It is refused, whole, for a game TeamStation scores, for a play the game
 * does not have, for a play named twice, for any event that is not a GUMBO
 * play event or has no time (an ISO 8601 date-time), and for any person an event names (its player,
 * pitcher, replaced player or a runner on base) who is not a user: a
 * statistics rebuild would stop at that game. A play not named keeps its events. Each
 * event's `description` is dropped, as for any outside scorer's play.
 */
export async function addPlayEvents(
  db: Kysely<Database>,
  gameId: string,
  body: PlayEventsBody
): Promise<AddedPlayEvents> {
  const indexes = body.plays.map(play => play.atBatIndex)
  if (new Set(indexes).size !== indexes.length)
    throw badRequest('Two plays share an atBatIndex')
  return await atomic(db, async trx => {
    await lockPlayerEdits(trx)
    const game = await trx
      .selectFrom('games')
      .select([
        'id',
        'scoringOwner',
        'home_team_id',
        'away_team_id',
        'currentPlay'
      ])
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (game == null) throw notFound()
    if (game.scoringOwner === 'teamstation')
      throw conflict('This game is scored in TeamStation')
    const stored = new Map(
      (
        await trx
          .selectFrom('events')
          .select(['id', 'atBatIndex', 'gumbo'])
          .where('gameId', '=', gameId)
          .execute()
      ).map(row => [row.atBatIndex, row])
    )
    const writes: Array<{ id: string; gumbo: Record<string, unknown> }> = []
    for (const play of body.plays) {
      const row = stored.get(play.atBatIndex)
      if (row == null)
        throw badRequest(`The game has no play ${play.atBatIndex}`)
      const untimed = play.playEvents.findIndex(event => !timed(event))
      if (untimed >= 0)
        throw badRequest(
          `Play ${play.atBatIndex}: event ${untimed} has no startTime (an ISO 8601 date-time)`
        )
      // As for any outside scorer's play (`storedGumbo`).
      const gumbo = {
        ...(row.gumbo as Record<string, unknown>),
        playEvents: withoutDescriptions(play.playEvents)
      }
      const wrong = gumboViolations(gumbo).find(violation =>
        violation.path.startsWith('playEvents')
      )
      if (wrong != null)
        throw badRequest(
          `Play ${play.atBatIndex}: ${wrong.path}: ${wrong.message}`
        )
      writes.push({ id: row.id, gumbo })
    }
    const named = new Map<number, string>()
    for (const play of body.plays)
      play.playEvents.forEach((event, index) => {
        for (const id of peopleIn(event)) {
          const where = `Play ${play.atBatIndex}: event ${index}`
          // A rebuild would stop at it as surely as at a stranger.
          if (!isUserId(id))
            throw badRequest(
              `${where} names person ${JSON.stringify(id)}, which is not a user id`
            )
          if (!named.has(id)) named.set(id, where)
        }
      })
    if (named.size > 0) {
      const users = new Set(
        (
          await trx
            .selectFrom('gumbo_ids')
            .select('gumbo_id')
            .where('gumbo_id', 'in', [...named.keys()])
            .execute()
        ).map(row => row.gumbo_id)
      )
      const unknown = [...named].find(([id]) => !users.has(id))
      if (unknown != null)
        throw badRequest(
          `${unknown[1]} names person ${unknown[0]}, who is not a user`
        )
    }
    const replacements = new Map(writes.map(write => [write.id, write.gumbo]))
    await assertStoredScoringRoles(trx, game, {
      plays: [...stored.values()].map(
        row => (replacements.get(row.id) ?? row.gumbo) as GumboPlay
      ),
      currentPlay: game.currentPlay as CurrentPlay | null
    })
    const now = new Date()
    for (const write of writes) {
      await trx
        .updateTable('events')
        .set({ gumbo: write.gumbo, updatedAt: now })
        .where('id', '=', write.id)
        .execute()
    }
    // The board's timeline is cached under the game's updated_at.
    await trx
      .updateTable('games')
      .set({ updated_at: now })
      .where('id', '=', gameId)
      .execute()
    await notifyGameChange(trx, { game: gameId, kind: 'plays' })
    return {
      plays: writes.length,
      events: body.plays.reduce((sum, play) => sum + play.playEvents.length, 0)
    }
  })
}
