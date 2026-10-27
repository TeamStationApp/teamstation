import type { Kysely, Selectable } from 'kysely'

import type {
  EngineBooking,
  EngineInput,
  PlannedGame,
  ScheduleOption
} from '../../common/autoScheduler/types'
import { badRequest, conflict, notFound } from '../../common/errors'
import { gameCalendarDay } from '../../common/gameTime'
import { makeId } from '../../common/ids'
import {
  type AddedGame,
  editedGames,
  type PreviewEdits,
  type PreviewRequest,
  type SchedulePreview
} from '../../common/schedulePreviews'
import { fieldSizeLabel } from '../../common/venues'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database, SchedulePreviewsTable } from '../db/database'
import type { Clock } from '../groups/requests'
import { requireGroupAdmin } from '../groups/rights'
import { chosenSeasonIds } from '../scheduler/setup'
import { occupancy } from '../venues/occupancy'
import { buildOffThread } from './buildOffThread'
import { noticeTeams, type Tallies } from './cancel'
import { proposePlanned } from './propose'
import {
  gamesToReschedule,
  publishedStates,
  rejectPublished
} from './reschedule'
import { type Holding, ruleProblem } from './rules'
import {
  type RescheduleRef,
  ruleContext,
  runGames,
  type Snapshot,
  snapshot,
  upcoming
} from './snapshot'

type Db = Kysely<Database>
export type PreviewRow = Selectable<SchedulePreviewsTable>

/** A preview's row, for an admin of its league. */
export async function previewFor(
  db: Db,
  actor: Actor,
  previewId: string,
  options: { forUpdate?: boolean } = {}
): Promise<PreviewRow> {
  let query = db
    .selectFrom('schedule_previews')
    .selectAll()
    .where('id', '=', previewId)
  if (options.forUpdate === true) query = query.forUpdate()
  const row = await query.executeTakeFirst()
  if (row == null) throw notFound()
  await requireGroupAdmin(db, actor, { kind: 'league', id: row.league_id })
  return row
}

export function snapshotOf(row: PreviewRow): Snapshot {
  return row.input as Snapshot
}

export function optionsOf(row: PreviewRow): ScheduleOption[] {
  return row.options as ScheduleOption[]
}

export function editsOf(row: PreviewRow): PreviewEdits {
  return row.edits as PreviewEdits
}

/** A preview as the API returns it. */
export async function previewView(
  db: Db,
  row: PreviewRow,
  clock: Clock
): Promise<SchedulePreview> {
  const snap = snapshotOf(row)
  const edits = editsOf(row)
  return {
    id: row.id,
    leagueId: row.league_id,
    mode: row.mode,
    existing: snap.existing,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    options: optionsOf(row),
    blocking: row.blocking,
    edits: {
      option: edits.option,
      rejectedGameKeys: edits.rejectedGameKeys,
      addedGames: edits.addedGames.map(game => ({ ...game }))
    },
    replacing: snap.replaceGameIds.length,
    publishedOption: row.published_option,
    publishedAt: row.published_at?.toISOString() ?? null,
    published:
      row.status === 'published'
        ? await publishedStates(db, row.id, clock)
        : [],
    teams: snap.teams,
    seasons: snap.engine.seasons.map(season => ({
      id: season.id,
      name: season.name,
      // The season's stored zone, which no time here is read in.
      timezone:
        snap.seasons.find(each => each.id === season.id)?.timezone ?? 'UTC',
      gameMinutes: season.settings.gameMinutes,
      participants: season.participants,
      exhibitionTeams: season.exhibitionTeams
    })),
    // Each field's zone, which its games' times are placed and read in.
    fields: snap.fields.map(field => ({
      ...field,
      timezone:
        snap.engine.fields.find(each => each.id === field.id)?.availability
          .timezone ?? 'UTC'
    }))
  }
}

/**
 * Builds a preview of the league's next schedule: snapshots what it runs
 * on, runs the engine, and stores up to three options. A first build of
 * seasons that already have upcoming games must say whether to replace
 * them or work around them. A partial build places only the listed teams'
 * games, replacing theirs; recalculating an open preview keeps its option's
 * games but the rejected ones, and the games added to it, and discards it.
 * The engine runs on a worker thread, outside any transaction; what it ran
 * on is read before, and its options are stored after, provided the
 * preview it recalculates has not changed meanwhile.
 */
export async function buildPreview(
  db: Db,
  actor: Actor,
  leagueId: string,
  request: PreviewRequest,
  clock: Clock
): Promise<SchedulePreview> {
  await requireGroupAdmin(db, actor, { kind: 'league', id: leagueId })
  const plan = await atomic(db, async trx => {
    let existing = request.existing
    let teamIds = request.teamIds ?? null
    let keep: PlannedGame[] | undefined
    let required: NonNullable<EngineInput['required']> | undefined
    let avoid: EngineBooking[] = []
    let earlier: PreviewRow | undefined
    if (request.fromPreviewId != null) {
      earlier = await previewFor(trx, actor, request.fromPreviewId)
      if (earlier.league_id !== leagueId) throw notFound()
      if (earlier.status !== 'open')
        throw conflict('This preview can no longer be recalculated')
      const option = optionsOf(earlier)[request.option ?? 0]
      if (option == null)
        throw badRequest('Choose one of the preview’s options')
      const earlierSnap = snapshotOf(earlier)
      existing = earlierSnap.existing
      teamIds = earlierSnap.teamIds
      const edits = editsOf(earlier)
      keep = editedGames(option, edits, request.option ?? 0)
      // Only the rejected games are placed again, and not where they were.
      const rejected =
        edits.option === (request.option ?? 0)
          ? option.games.filter(game =>
              edits.rejectedGameKeys.includes(game.key)
            )
          : []
      required = rejected.map(game => ({
        key: game.key,
        seasonId: game.seasonId,
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId,
        exhibition: game.exhibition
      }))
      avoid = rejected.map(game => ({
        key: `rejected:${game.key}`,
        fieldId: game.fieldId,
        size: game.size,
        teamIds: [],
        start: Date.parse(game.startAt),
        end: Date.parse(game.endAt)
      }))
    }
    if (request.mode === 'partial' && existing == null) existing = 'replace'
    if (existing == null) {
      const now = clock.now()
      const seasonIds = await chosenSeasonIds(trx, leagueId)
      const ahead = (await runGames(trx, seasonIds)).filter(game =>
        upcoming(game, now)
      )
      if (ahead.length > 0)
        throw conflict('These seasons already have upcoming games', {
          existingGames: ahead.length
        })
      existing = 'workAround'
    }
    const listed = (await gamesToReschedule(trx, leagueId, clock)).filter(
      game =>
        teamIds == null ||
        (teamIds.includes(game.homeTeamId) && teamIds.includes(game.awayTeamId))
    )
    // A recalculation places again only its rejected games, so it carries
    // the listed games the build it recalculates was made with; one listed
    // since was placed by neither.
    const reschedules: RescheduleRef[] =
      earlier != null
        ? snapshotOf(earlier).reschedules
        : listed.map(game => ({
            previewId: game.previewId,
            gameKey: game.gameKey
          }))
    // Recalculating just some teams places each listed game again, away
    // from where it was, with the games it replaces.
    if (request.fromPreviewId == null && teamIds != null) {
      required = listed.map(game => ({
        key: rescheduleKey(game),
        seasonId: game.seasonId,
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId,
        exhibition: game.exhibition
      }))
      avoid = listed
        .filter(game => game.fieldId != null && game.startAt !== '')
        .map(game => ({
          key: `listed:${rescheduleKey(game)}`,
          fieldId: game.fieldId,
          size: null,
          teamIds: [],
          start: Date.parse(game.startAt),
          end:
            game.endAt == null
              ? Date.parse(game.startAt) + 2 * 60 * 60 * 1000
              : Date.parse(game.endAt)
        }))
    }
    const snap = await snapshot(
      trx,
      {
        leagueId,
        existing,
        teamIds,
        keep,
        reschedules,
        required,
        avoid,
        requireReplaced: request.fromPreviewId == null && teamIds != null
      },
      clock
    )
    return { snap, keep, earlier }
  })
  const { snap, keep, earlier } = plan
  const result = await buildOffThread(snap.engine)
  // A recalculation's options hold the games it kept as well as the ones
  // it placed again, so publishing it publishes them all.
  const options =
    keep == null
      ? result.options
      : result.options.map(option => ({
          ...option,
          games: withKept(keep, option.games)
        }))
  return await atomic(db, async trx => {
    if (earlier != null) {
      const now = await previewFor(trx, actor, earlier.id, { forUpdate: true })
      if (now.status !== 'open')
        throw conflict('This preview can no longer be recalculated')
      if (JSON.stringify(now.edits) !== JSON.stringify(earlier.edits))
        throw conflict(
          'This preview changed while it was recalculated. Recalculate it again.'
        )
    }
    const id = makeId('schedulePreview')
    const edits: PreviewEdits = {
      option: 0,
      rejectedGameKeys: [],
      addedGames: []
    }
    await trx
      .insertInto('schedule_previews')
      .values({
        id,
        league_id: leagueId,
        created_by: actor.userId,
        created_at: clock.now(),
        // A recalculation is the build it recalculates, placed again.
        mode: earlier?.mode ?? request.mode,
        input: JSON.stringify(snap),
        options: JSON.stringify(options),
        blocking: result.blocking,
        edits: JSON.stringify(edits)
      })
      .execute()
    if (earlier != null)
      await trx
        .updateTable('schedule_previews')
        .set({ status: 'discarded' })
        .where('id', '=', earlier.id)
        .execute()
    const row = await trx
      .selectFrom('schedule_previews')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return await previewView(trx, row, clock)
  })
}

/**
 * The kept games of a recalculated option, then the games placed again,
 * in start order. A placed game whose key a kept game already has gets a
 * key of its own.
 */
export function withKept(
  kept: PlannedGame[],
  placed: PlannedGame[]
): PlannedGame[] {
  const keys = new Set(kept.map(game => game.key))
  const fresh = placed.map(game => {
    let key = game.key
    for (let n = 2; keys.has(key); n++) key = `${game.key}:${n}`
    keys.add(key)
    return { ...game, key }
  })
  return [...kept, ...fresh].sort((a, b) =>
    a.startAt === b.startAt
      ? a.key.localeCompare(b.key)
      : a.startAt.localeCompare(b.startAt)
  )
}

/** The key a listed game's matchup is placed under. */
export function rescheduleKey(game: {
  previewId: string
  gameKey: string
}): string {
  return `listed:${game.previewId}:${game.gameKey}`
}

/** An added game as an option holds it. */
function planned(game: AddedGame, key: string): PlannedGame {
  return { key, ...game }
}

/** A game, fixed or placed, as the hard rules see it. */
export function holdingOf(game: PlannedGame): Holding {
  return {
    key: game.key,
    fieldId: game.fieldId,
    size: game.size,
    teamIds: [game.homeTeamId, game.awayTeamId],
    seasonId: game.seasonId,
    start: Date.parse(game.startAt),
    end: Date.parse(game.endAt)
  }
}

/**
 * Checks an added game against the hard rules the engine places games by,
 * among the given other games, and says what is wrong with it: it is still
 * to come, within its season's dates on its field's local calendar, in the
 * season's field size, and between two of the season's teams.
 */
export function requireKeepsRules(
  snap: Snapshot,
  game: PlannedGame,
  others: Holding[],
  now: Date
): void {
  const season = snap.engine.seasons.find(each => each.id === game.seasonId)
  if (season == null) throw badRequest('Choose a season of this run')
  if (Date.parse(game.startAt) <= now.getTime())
    throw badRequest('Choose a time still to come')
  const field = snap.engine.fields.find(each => each.id === game.fieldId)
  const day = gameCalendarDay(
    game.startAt,
    field?.availability.timezone ?? 'UTC'
  )
  if (day < season.settings.startsOn || day > season.settings.endsOn)
    throw badRequest(`Choose a day within ${season.name}’s dates`)
  if (game.size !== season.settings.fieldSize)
    throw badRequest(
      `${season.name} plays on ${fieldSizeLabel(season.settings.fieldSize)} fields`
    )
  const teams = new Set([...season.participants, ...season.exhibitionTeams])
  if (!teams.has(game.homeTeamId) || !teams.has(game.awayTeamId))
    throw badRequest(`Choose two of ${season.name}’s teams`)
  const problem = ruleProblem(
    {
      ...holdingOf(game),
      fieldId: game.fieldId,
      size: game.size,
      seasonId: game.seasonId
    },
    ruleContext(snap, others)
  )
  if (problem != null) throw badRequest(problem)
}

/** What holds the run's fields and teams now, from the database. */
export async function currentHoldings(
  db: Db,
  snap: Snapshot,
  clock: Clock,
  leaveOut: string[]
): Promise<Holding[]> {
  const teamIds = [
    ...new Set(
      snap.engine.seasons.flatMap(season => [
        ...season.participants,
        ...season.exhibitionTeams
      ])
    )
  ]
  return (
    await occupancy(
      db,
      {
        fieldIds: snap.engine.fields.map(field => field.id),
        teamIds,
        from: clock.now()
      },
      clock
    )
  )
    .filter(booking => !leaveOut.includes(booking.key))
    .map(booking => ({
      key: booking.key,
      fieldId: booking.fieldId,
      size: booking.size,
      teamIds: [booking.homeTeamId, booking.awayTeamId],
      seasonId: booking.seasonId,
      start: booking.start,
      end: booking.end
    }))
}

/**
 * Edits one option of a preview. On an open preview the rejected games are
 * left out of it and the added games, each checked against the hard rules,
 * join it; the edits apply when it is published or recalculated. On a
 * published preview both act at once: rejected games come off the
 * schedules, and added games are proposed the way publishing proposes.
 */
export async function editPreview(
  db: Db,
  actor: Actor,
  previewId: string,
  body: { option: number; rejectedGameKeys: string[]; addedGames: AddedGame[] },
  clock: Clock
): Promise<SchedulePreview> {
  return await atomic(db, async trx => {
    const row = await previewFor(trx, actor, previewId, { forUpdate: true })
    const snap = snapshotOf(row)
    const options = optionsOf(row)
    if (row.status === 'discarded')
      throw conflict('This preview was replaced by a newer one')
    if (row.status === 'open') {
      const option = options[body.option]
      if (option == null)
        throw badRequest('Choose one of the preview’s options')
      const before = editsOf(row)
      const edits: PreviewEdits =
        before.option === body.option
          ? before
          : { option: body.option, rejectedGameKeys: [], addedGames: [] }
      const keys = new Set([
        ...option.games.map(game => game.key),
        ...edits.addedGames.map(game => game.key)
      ])
      for (const key of body.rejectedGameKeys)
        if (!keys.has(key)) throw badRequest('Reject games of this option')
      const rejected = new Set([
        ...edits.rejectedGameKeys,
        ...body.rejectedGameKeys
      ])
      let added = edits.addedGames.filter(game => !rejected.has(game.key))
      const kept = (): PlannedGame[] => [
        ...option.games.filter(game => !rejected.has(game.key)),
        ...added
      ]
      for (const game of body.addedGames) {
        const next = planned(game, `added:${makeId('game')}`)
        requireKeepsRules(
          snap,
          next,
          [
            // The build's own markers of slots to avoid hold nothing.
            ...snap.engine.bookings
              .filter(
                booking =>
                  !booking.key.startsWith('rejected:') &&
                  !booking.key.startsWith('listed:')
              )
              .map(booking => ({
                ...booking,
                seasonId: null
              })),
            // A recalculation's kept games are the option's own, below.
            ...snap.engine.fixed
              .filter(fixed => !fixed.key.startsWith('kept:'))
              .map(fixed => ({
                key: fixed.key,
                fieldId: fixed.fieldId,
                size: fixed.size,
                teamIds: [fixed.homeTeamId, fixed.awayTeamId],
                seasonId: fixed.seasonId,
                start: fixed.start,
                end: fixed.end
              })),
            ...kept().map(holdingOf)
          ],
          clock.now()
        )
        added = [...added, next]
      }
      await trx
        .updateTable('schedule_previews')
        .set({
          edits: JSON.stringify({
            option: body.option,
            rejectedGameKeys: [...rejected].filter(key =>
              option.games.some(game => game.key === key)
            ),
            addedGames: added
          })
        })
        .where('id', '=', row.id)
        .execute()
    } else {
      // Proposing at once, it waits for the league's other publications.
      await lockKeys(trx, [`schedule-league:${row.league_id}`])
      await rejectPublished(trx, actor, row, body.rejectedGameKeys, clock)
      const games: PlannedGame[] = []
      for (const game of body.addedGames) {
        const next = planned(game, `added:${makeId('game')}`)
        requireKeepsRules(
          snap,
          next,
          [
            ...(await currentHoldings(trx, snap, clock, [])),
            ...games.map(holdingOf)
          ],
          clock.now()
        )
        games.push(next)
      }
      const tallies: Tallies = new Map()
      await proposePlanned(trx, actor, row.id, snap, games, clock, tallies)
      await noticeTeams(trx, tallies, { actorId: actor.userId })
      // The published option lists them with its own games, where they can
      // be rejected like any other.
      if (games.length > 0) {
        const publishedOption = row.published_option ?? 0
        const before = editsOf(row)
        const edits: PreviewEdits =
          before.option === publishedOption
            ? before
            : { option: publishedOption, rejectedGameKeys: [], addedGames: [] }
        await trx
          .updateTable('schedule_previews')
          .set({
            edits: JSON.stringify({
              ...edits,
              addedGames: [...edits.addedGames, ...games]
            })
          })
          .where('id', '=', row.id)
          .execute()
      }
    }
    const updated = await trx
      .selectFrom('schedule_previews')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow()
    return await previewView(trx, updated, clock)
  })
}
