import { isDeepStrictEqual } from 'node:util'

import type { Kysely, Selectable, Transaction } from 'kysely'

import type {
  EngineBooking,
  EngineInput,
  PlannedGame,
  ScheduleOption
} from '../../common/autoScheduler/types'
import { summarizeResult } from '../../common/autoScheduler/validateResult'
import { badRequest, conflict, notFound } from '../../common/errors'
import { gameCalendarDay } from '../../common/gameTime'
import { makeId } from '../../common/ids'
import {
  type AddedGame,
  asPreviewResult,
  editedGames,
  type PreparedPreview,
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
import { noticeTeams, type Tallies } from './cancel'
import { proposePlanned } from './propose'
import {
  gamesToReschedule,
  publishedStates,
  rejectPublished
} from './reschedule'
import { type Holding, managerConflict, ruleProblem } from './rules'
import {
  headCoachesOf,
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
  // Serialize preview writers without blocking a game that references this preview.
  if (options.forUpdate === true) query = query.forNoKeyUpdate()
  const row = await query.executeTakeFirst()
  if (row == null) throw notFound()
  await requireGroupAdmin(db, actor, { kind: 'league', id: row.league_id })
  return row
}

/** Serialize calendar writes, then check the authority that still holds under the lock. */
export async function lockScheduleForWrite(
  trx: Transaction<Database>,
  actor: Actor,
  leagueId: string
): Promise<void> {
  await lockKeys(trx, ['creation:parent-graph', `schedule-league:${leagueId}`])
  await requireGroupAdmin(trx, actor, { kind: 'league', id: leagueId })
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
      // Its first day, where the preview's Week 1 starts.
      startsOn: season.settings.startsOn,
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

/** Prepare authorized input for the device; keep the snapshot for result validation. */
export async function preparePreview(
  db: Db,
  actor: Actor,
  leagueId: string,
  request: PreviewRequest,
  clock: Clock
): Promise<PreparedPreview> {
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
        avoidHeadCoachConflicts:
          earlier == null
            ? undefined
            : (snapshotOf(earlier).avoidHeadCoachConflicts ?? true),
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
  const id = makeId('schedulePreview')
  snap.preparation = {
    keep,
    earlier:
      earlier == null ? undefined : { id: earlier.id, edits: earlier.edits }
  }
  await db
    .insertInto('schedule_previews')
    .values({
      id,
      league_id: leagueId,
      created_by: actor.userId,
      created_at: clock.now(),
      mode: earlier?.mode ?? request.mode,
      input: JSON.stringify(snap),
      options: '[]',
      blocking: null,
      edits: JSON.stringify({
        option: 0,
        rejectedGameKeys: [],
        addedGames: []
      }),
      status: 'building'
    })
    .execute()
  return { id, input: snap.engine }
}

/** Validate device placements against the immutable server-held input. */
export function validatePlacements(
  snap: Snapshot,
  result: ReturnType<typeof asPreviewResult>
): void {
  const { engine } = snap
  for (const option of result.options) {
    const keys = new Set<string>()
    const counts = new Map<string, number>()
    const holdings: Holding[] = [
      ...engine.bookings.map(booking => ({ ...booking, seasonId: null })),
      ...engine.fixed.map(game => ({
        ...game,
        teamIds: [game.homeTeamId, game.awayTeamId]
      }))
    ]
    const weekly: Holding[] =
      engine.weeklyGames == null
        ? [...holdings]
        : engine.weeklyGames.map((game, index) => ({
            ...game,
            key: `weekly:${index}`,
            size: null,
            end: game.start
          }))
    for (const game of option.games) {
      const start = Date.parse(game.startAt)
      const end = Date.parse(game.endAt)
      const season = engine.seasons.find(season => season.id === game.seasonId)
      if (
        season == null ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        game.key.length === 0 ||
        game.key.length > 300 ||
        keys.has(game.key) ||
        engine.fixed.some(fixed => fixed.key === game.key) ||
        engine.bookings.some(booking => booking.key === game.key)
      )
        throw badRequest('Submit unique games with valid seasons and times')
      keys.add(game.key)
      if (
        game.homeTeamId === game.awayTeamId ||
        end - start !== season.settings.gameMinutes * 60000
      )
        throw badRequest(
          'Each game needs two different teams and the season’s game length'
        )
      const participants = new Set(season.participants)
      const exhibition = new Set(season.exhibitionTeams)
      if (
        engine.required == null &&
        (game.exhibition
          ? !(
              (participants.has(game.homeTeamId) &&
                exhibition.has(game.awayTeamId)) ||
              (participants.has(game.awayTeamId) &&
                exhibition.has(game.homeTeamId))
            )
          : !participants.has(game.homeTeamId) ||
            !participants.has(game.awayTeamId))
      )
        throw badRequest('Choose the season’s regular or exhibition matchups')
      if (engine.required != null) {
        if (
          !engine.required.some(
            required =>
              required.key === game.key &&
              required.seasonId === game.seasonId &&
              required.homeTeamId === game.homeTeamId &&
              required.awayTeamId === game.awayTeamId &&
              required.exhibition === game.exhibition
          )
        )
          throw badRequest('Place only the requested games')
      } else {
        if (
          engine.teamIds != null &&
          (!engine.teamIds.includes(game.homeTeamId) ||
            !engine.teamIds.includes(game.awayTeamId))
        )
          throw badRequest('Place only the selected teams')
        for (const team of [game.homeTeamId, game.awayTeamId]) {
          if (!participants.has(team)) continue
          const key = `${game.seasonId}:${team}:${game.exhibition}`
          const fixed = engine.fixed.filter(
            fixed =>
              fixed.seasonId === game.seasonId &&
              fixed.exhibition === game.exhibition &&
              [fixed.homeTeamId, fixed.awayTeamId].includes(team)
          ).length
          const count = (counts.get(key) ?? 0) + 1
          counts.set(key, count)
          if (
            count + fixed >
            (game.exhibition
              ? season.settings.exhibitionGames
              : season.settings.regularGames)
          )
            throw badRequest('Do not exceed the season’s requested game counts')
        }
      }
      requireKeepsRules(
        snap,
        game,
        holdings,
        new Date(engine.notBefore - 1),
        engine.headCoaches,
        weekly
      )
      holdings.push(holdingOf(game))
      weekly.push(holdingOf(game))
    }
  }
}

/** Complete a prepared preview; a retry of the same result is idempotent. */
export async function completePreview(
  db: Db,
  actor: Actor,
  previewId: string,
  raw: unknown,
  clock: Clock
): Promise<SchedulePreview> {
  const result = asPreviewResult(raw)
  return await atomic(db, async trx => {
    const row = await previewFor(trx, actor, previewId, { forUpdate: true })
    const snap = snapshotOf(row)
    const preparation = snap.preparation
    if (row.status !== 'building') {
      if (
        row.status !== 'discarded' &&
        isDeepStrictEqual(preparation?.result, result)
      )
        return await previewView(trx, row, clock)
      throw conflict('This preview is no longer waiting for a device result')
    }
    if (preparation == null) throw conflict('Prepare the schedule again')
    if (preparation.earlier != null) {
      const earlier = await previewFor(trx, actor, preparation.earlier.id, {
        forUpdate: true
      })
      if (
        earlier.status !== 'open' ||
        !isDeepStrictEqual(earlier.edits, preparation.earlier.edits)
      )
        throw conflict(
          'This preview changed while it was recalculated. Recalculate it again.'
        )
    }
    validatePlacements(snap, result)
    let summarized: ReturnType<typeof asPreviewResult>
    try {
      summarized = summarizeResult(snap.engine, result)
    } catch (error) {
      if (error instanceof TypeError) throw badRequest(error.message)
      throw error
    }
    const options =
      preparation.keep == null
        ? summarized.options
        : summarized.options.map(option => ({
            ...option,
            games: withKept(preparation.keep!, option.games)
          }))
    preparation.result = result
    await trx
      .updateTable('schedule_previews')
      .set({
        status: 'open',
        input: JSON.stringify(snap),
        options: JSON.stringify(options),
        blocking: summarized.blocking
      })
      .where('id', '=', row.id)
      .execute()
    if (preparation.earlier != null)
      await trx
        .updateTable('schedule_previews')
        .set({ status: 'discarded' })
        .where('id', '=', preparation.earlier.id)
        .execute()
    const updated = await trx
      .selectFrom('schedule_previews')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow()
    return await previewView(trx, updated, clock)
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
  now: Date,
  headCoaches?: Record<string, string>,
  weeklyOthers?: Holding[]
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
  const required = snap.engine.required?.find(
    required =>
      required.key === game.key &&
      required.seasonId === game.seasonId &&
      required.homeTeamId === game.homeTeamId &&
      required.awayTeamId === game.awayTeamId &&
      required.exhibition === game.exhibition
  )
  if (required != null) {
    teams.add(required.homeTeamId)
    teams.add(required.awayTeamId)
  }
  if (!teams.has(game.homeTeamId) || !teams.has(game.awayTeamId))
    throw badRequest(`Choose two of ${season.name}’s teams`)
  const problem = ruleProblem(
    {
      ...holdingOf(game),
      fieldId: game.fieldId,
      size: game.size,
      seasonId: game.seasonId
    },
    { ...ruleContext(snap, others, headCoaches), weeklyOthers }
  )
  if (problem != null) throw badRequest(problem)
}

/** What holds the run's fields and teams now, from the database. */
export async function currentHoldings(
  db: Db,
  snap: Snapshot,
  clock: Clock,
  leaveOut: string[]
): Promise<{ holdings: Holding[]; headCoaches: Record<string, string> }> {
  const settings = await db
    .selectFrom('season_schedule_settings')
    .select(['season_id', 'max_games_on_weekdays', 'max_games_on_weekend'])
    .where(
      'season_id',
      'in',
      snap.engine.seasons.map(season => season.id)
    )
    .execute()
  for (const season of snap.engine.seasons) {
    const current = settings.find(row => row.season_id === season.id)
    season.settings = {
      ...season.settings,
      maxGamesOnWeekdays: current?.max_games_on_weekdays ?? 1,
      maxGamesOnWeekend: current?.max_games_on_weekend ?? 1
    }
  }
  const teamIds = [
    ...new Set([
      ...snap.engine.seasons.flatMap(season => [
        ...season.participants,
        ...season.exhibitionTeams
      ]),
      ...snap.engine.fixed.flatMap(game => [game.homeTeamId, game.awayTeamId]),
      ...(snap.engine.required ?? []).flatMap(game => [
        game.homeTeamId,
        game.awayTeamId
      ])
    ])
  ]
  const headCoaches =
    snap.avoidHeadCoachConflicts === false
      ? {}
      : await headCoachesOf(db, teamIds)
  const holdings = (
    await occupancy(
      db,
      {
        fieldIds: snap.engine.fields.map(field => field.id),
        teamIds: [...new Set([...teamIds, ...Object.keys(headCoaches)])],
        keepScheduledFor: Object.keys(headCoaches),
        from: new Date(clock.now().getTime() - 8 * 86400000)
      },
      clock
    )
  )
    .filter(booking => !leaveOut.includes(booking.key))
    .map(booking => ({
      managerOnly: booking.managerOnly,
      key: booking.key,
      fieldId: booking.fieldId,
      size: booking.size,
      teamIds: [booking.homeTeamId, booking.awayTeamId],
      seasonId: booking.seasonId,
      start: booking.start,
      end: booking.end
    }))
  return { headCoaches, holdings }
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
    if (row.status === 'building')
      throw conflict('The device has not finished this schedule')
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
      const live =
        body.addedGames.length === 0
          ? undefined
          : await currentHoldings(trx, snap, clock, snap.replaceGameIds)
      for (const game of body.addedGames) {
        const next = planned(game, `added:${makeId('game')}`)
        const optionHoldings = kept().map(holdingOf)
        const candidate = holdingOf(next)
        // Team and field rules retain the preview snapshot. A manager's
        // calendar can change across leagues while this preview is open.
        if (
          live != null &&
          [...live.holdings, ...optionHoldings].some(other =>
            managerConflict(candidate, other, live.headCoaches)
          )
        )
          throw badRequest(
            'A Manager/Head Coach already has a game at this time.'
          )
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
            ...optionHoldings
          ],
          clock.now(),
          undefined,
          [...(live?.holdings ?? []), ...optionHoldings]
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
      await lockScheduleForWrite(trx, actor, row.league_id)
      await rejectPublished(trx, actor, row, body.rejectedGameKeys, clock)
      const games: PlannedGame[] = []
      const live =
        body.addedGames.length === 0
          ? { holdings: [], headCoaches: {} }
          : await currentHoldings(trx, snap, clock, [])
      for (const game of body.addedGames) {
        const next = planned(game, `added:${makeId('game')}`)
        requireKeepsRules(
          snap,
          next,
          [...live.holdings, ...games.map(holdingOf)],
          clock.now(),
          live.headCoaches
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
