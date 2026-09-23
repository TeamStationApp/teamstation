import type { Kysely } from 'kysely'

import type { GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import type { Database } from '../db/database'
import { requestGameStats } from '../statsBuilder/request'

export interface GameTeams {
  homeTeamId: string | null
  awayTeamId: string | null
}

/**
 * The team batting this half. Top is the away team, bottom is the home team,
 * and a missing half stays unset. Read from the document, not the generated
 * column.
 */
export function battingTeamForHalf(
  halfInning: string | null | undefined,
  teams: GameTeams
): string | null {
  if (halfInning === 'top') return teams.awayTeamId
  if (halfInning === 'bottom') return teams.homeTeamId
  return null
}

/**
 * A sender may name a credit's side `home` or `away`. Stored credits use the
 * game's team ids.
 */
export function teamIdsOnCredits<T extends { teamId?: string | null }>(
  credits: T[],
  teams: GameTeams
): T[] {
  return credits.map(credit => ({
    ...credit,
    teamId:
      credit.teamId === 'home'
        ? teams.homeTeamId
        : credit.teamId === 'away'
          ? teams.awayTeamId
          : (credit.teamId ?? null)
  }))
}

/**
 * Who wrote a play: `gamestation` for GameStation's own scoring, `manual` for a
 * person typing it in, and `external` for any outside scorer.
 */
export type PlaySource = 'external' | 'manual' | 'gamestation'

export interface PlayWrite {
  gumbo: GumboPlay
  startTime?: Date | string | null
  endTime?: Date | string | null
  source: PlaySource
}

export interface ReplaceGameEventsInput extends GameTeams {
  gameId: string
  /** The whole set: a stored play whose index is not here is deleted. */
  plays: PlayWrite[]
}

/**
 * A re-post that omits `credits` keeps the list already stored.
 *
 * An empty list means the play was looked at and nothing on it is worth a
 * highlight. Leaving the key off would read as "nobody has looked", and those
 * plays would show up again.
 */
function withKeptCredits(gumbo: GumboPlay, previous: unknown): GumboPlay {
  if (gumbo.credits != null) return gumbo
  // The stored document is untyped JSON.
  if (
    previous == null ||
    typeof previous !== 'object' ||
    Array.isArray(previous)
  ) {
    return gumbo
  }
  const credits = (previous as { credits?: unknown }).credits
  if (credits == null) return gumbo
  // The stored list passed the same cleaner when its play was posted.
  return { ...gumbo, credits: credits as GumboPlay['credits'] }
}

/**
 * The stored document is the posted Gumbo play, without the `source` a sender
 * keeps beside it while it builds the play.
 *
 * Gumbo's descriptions — `result.description` and each `playEvents[]` one —
 * are dropped from a play an outside scorer sent (`external`): they are that
 * service's words, and GameStation shows a play in its own reading of the
 * type and credits, written when it is shown. A `manual` or `gamestation`
 * play keeps them, because they are a person's or GameStation's own words,
 * and the document is otherwise stored as it was sent.
 */
export function storedGumbo(
  gumbo: GumboPlay,
  source: PlaySource
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...gumbo }
  delete next.source
  if (source !== 'external') return next
  const { description, ...result } = gumbo.result
  next.result = result
  // `playEvents` is not checked by the cleaner, so each entry is looked at.
  if (Array.isArray(gumbo.playEvents)) {
    next.playEvents = gumbo.playEvents.map((event: unknown) => {
      if (event == null || typeof event !== 'object' || Array.isArray(event)) {
        return event
      }
      const kept = { ...(event as Record<string, unknown>) }
      delete kept.description
      return kept
    })
  }
  return next
}

/**
 * Replaces every play of a game with the ones given.
 *
 * What people set on a play outlives the replacement of the play at the same
 * index: whether it is hidden, its title, its time nudge, and the fielder,
 * catcher and scorer rows. A play posted without `credits` keeps the list
 * already stored.
 */
export async function replaceGameEvents(
  db: Kysely<Database>,
  input: ReplaceGameEventsInput
): Promise<void> {
  const existing = await db
    .selectFrom('events')
    .select([
      'id',
      'atBatIndex',
      'hidden',
      'titleOverride',
      'timeNudgeSec',
      'gumbo'
    ])
    .where('gameId', '=', input.gameId)
    .execute()
  const edits = new Map(existing.map(row => [row.atBatIndex, row]))

  const keptRoles =
    existing.length > 0
      ? await db
          .selectFrom('event_players')
          .select(['event_id', 'user_id', 'team_id', 'role', 'position'])
          .where(
            'event_id',
            'in',
            existing.map(row => row.id)
          )
          .where('role', 'in', ['fielder', 'catcher', 'scorer'])
          .execute()
      : []
  const rolesByEvent = new Map<string, typeof keptRoles>()
  for (const role of keptRoles) {
    const list = rolesByEvent.get(role.event_id) ?? []
    list.push(role)
    rolesByEvent.set(role.event_id, list)
  }

  await db.deleteFrom('events').where('gameId', '=', input.gameId).execute()

  const teams = {
    homeTeamId: input.homeTeamId,
    awayTeamId: input.awayTeamId
  }
  for (const play of input.plays) {
    const previous = edits.get(play.gumbo.about.atBatIndex)
    const eventId = makeId('event')
    await db
      .insertInto('events')
      .values({
        id: eventId,
        gameId: input.gameId,
        startTime: play.startTime ?? null,
        endTime: play.endTime ?? null,
        battingTeamId: battingTeamForHalf(play.gumbo.about.halfInning, teams),
        gumbo: storedGumbo(
          withKeptCredits(play.gumbo, previous?.gumbo),
          play.source
        ),
        source: play.source,
        hidden: previous?.hidden ?? false,
        titleOverride: previous?.titleOverride ?? null,
        timeNudgeSec: previous?.timeNudgeSec ?? 0
      })
      .execute()

    if (previous == null) continue
    for (const role of rolesByEvent.get(previous.id) ?? []) {
      await db
        .insertInto('event_players')
        .values({
          id: makeId('eventPlayer'),
          event_id: eventId,
          user_id: role.user_id,
          team_id: role.team_id,
          role: role.role,
          position: role.position
        })
        .execute()
    }
  }

  await requestGameStats(db, input.gameId)
}
