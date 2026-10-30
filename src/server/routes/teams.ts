import { Router } from 'express'
import { type Kysely, sql } from 'kysely'

import { asCreateTeamBody } from '../../common/createTeam'
import {
  badRequest,
  membersOnly,
  notFound,
  unauthorized
} from '../../common/errors'
import type { PlayerRsvpCounts } from '../../common/eventInfo'
import { shortNames } from '../../common/names'
import { scoreboardOpen } from '../../common/scoreboard'
import { inningsPitched } from '../../common/statExtras'
import {
  adminScopes,
  canKeepSongs,
  canManageRoster,
  canManageTeam,
  canScore,
  canSeeGame,
  canSeeTeam,
  givenRolesOnTeams,
  isHeadCoach,
  nonMemberTeam,
  roleScopes,
  type VisibleScopes,
  visibleScopes
} from '../access'
import type { Database } from '../db/database'
import { isRealVideo } from '../db/realVideos'
import { teamNames, teamStandings } from '../db/teamLookups'
import { creditsForHighlight } from '../events/credits'
import { teamEventDetail } from '../events/eventInfo'
import { teamPlayerRsvps } from '../events/playerRsvps'
import { whyEmpty } from '../events/whyEmpty'
import { resolvedFenceDistance } from '../games/fenceDistance'
import { gameIsLive } from '../games/gameLive'
import { gameAvailability } from '../games/rosterAvailability'
import { hasScoringEventsSql } from '../games/scoringActivity'
import {
  HIGHLIGHT_EVENT_COLUMNS,
  highlightEvent,
  withDropped
} from '../highlights'
import { cleanBody } from '../jsonBody'
import { receivingVideoIds } from '../live/receiving'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { posterSecond, posterUrl, warmPosters } from '../media/posters'
import { stillUrl } from '../media/stills'
import { warmVideoStills } from '../media/videoStills'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { hasRecordedPlays } from '../replay/replayable'
import { annotatePending, pendingSchedule } from '../schedule/pendingProjection'
import {
  type ScoreboardStore,
  ScoreboardUnavailable
} from '../scoreboard/scoreboardStore'
import { highlightSettings } from '../settings'
import { withRevision, withRevisionThen } from '../socket/syncRevision'
import {
  battingLines,
  battingRates,
  pitchingLines,
  pitchingRates
} from '../stats'
import { boxScoreOrder, pitchingOrder } from '../stats/boxScoreOrder'
import { teamRecords } from '../stats/records'
import { statRows } from '../stats/rows'
import { gameStatsStatus } from '../statsBuilder/status'
import { createTeam } from '../teams/createTeam'
import { followMerges } from '../teams/followMerges'
import { teamRoster } from '../teams/teamRoster'
import { gameUmpires } from '../umpires/assignments'
import { gameNames } from '../users/nameBook'
import {
  externalIdsAsked,
  schedulableSeasonIds,
  scheduleOf,
  valuesAsked
} from './seasons'

/** The kinds of team `GET /teams?kind=` lists. */
type TeamKindAsked = 'full' | 'external' | 'any'

/** `kind`: `full` unless asked, and one of the three. */
function kindAsked(asked: unknown): TeamKindAsked {
  if (asked === undefined) return 'full'
  if (asked === 'full' || asked === 'external' || asked === 'any') return asked
  throw badRequest('kind must be full, external or any')
}

/**
 * The watch path: teams, then that team's games newest first, then one game
 * with its videos and the highlights underneath them.
 *
 * Anybody signed in who is a member of neither side reads the **non-member
 * view** (`nonMemberTeam`, or for a game `canSeeGame` false), following the
 * team or not: the team's roster without pictures, its schedule, and each
 * game's score, innings and highlights. The figures, the box score and the
 * video itself answer 403 `membersOnly`, since the team and the game are no
 * secret from them. A team, game or video that is not there answers 404.
 * Signed out, the public page is all there is.
 *
 * `store` is the scoreboard's, which a game's answer asks whether its board
 * is open. Without one, or with Redis away, the game says `scoreboard: null`
 * and is otherwise the same.
 */
export function teamRoutes(
  db: Kysely<Database>,
  media: MediaContext,
  store?: ScoreboardStore
): Router {
  const router = Router()

  router.get(
    '/teams',
    requireActor,
    withRevision(db, async (db, req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const externalIds = externalIdsAsked(req.query.externalId)
      const seasonsAsked = valuesAsked(req.query.season, 'season')
      const kind = kindAsked(req.query.kind)
      if (kind !== 'full' && seasonsAsked == null) {
        throw badRequest('kind needs season')
      }

      // Asked by season: the season's own teams, and with `kind` the
      // external teams its games were played against, whoever the caller
      // belongs to, as `GET /seasons/:seasonId/teams` lists them. A season the
      // caller can neither see nor schedule in is not there.
      if (seasonsAsked != null) {
        await mustSeeSeasons(
          db,
          seasonsAsked,
          actor.userId,
          actor.isAdmin,
          scopes
        )
      }
      const inSeasons =
        seasonsAsked == null
          ? undefined
          : await seasonTeamIds(db, seasonsAsked, kind)

      // Otherwise external teams are opponents, not teams anybody belongs
      // to: they appear on a game and nowhere else, admin or not.
      let query = db
        .selectFrom('teams')
        .leftJoin('games', join =>
          join.on(eb =>
            eb.or([
              eb('games.home_team_id', '=', eb.ref('teams.id')),
              eb('games.away_team_id', '=', eb.ref('teams.id'))
            ])
          )
        )
        .select([
          'teams.id as id',
          'teams.name as name',
          'teams.short_name as short_name',
          'teams.logo_path as logo_path',
          'teams.kind as kind'
        ])
        .select(eb => eb.fn.max('games.start_at').as('lastPlayedAt'))
        // Which ids other systems know the team by, so a caller that asked
        // by one can tell which team answered to which.
        .select(eb =>
          eb
            .selectFrom('external_ids')
            .select(
              sql<
                string[]
              >`coalesce(array_agg(external_ids.external_id order by external_ids.external_id), '{}')`.as(
                'ids'
              )
            )
            .where('external_ids.entity_type', '=', 'team')
            .whereRef('external_ids.entity_id', '=', 'teams.id')
            .as('externalIds')
        )
        // A team merged into another is that team now: it has no games of
        // its own, and an id it still holds must not find it.
        .where('teams.merged_into', 'is', null)
      if (inSeasons != null) {
        query = query.where('teams.id', 'in', inSeasons)
      } else {
        query = query.where('teams.kind', '=', 'full')
        if (!scopes.isAdmin) {
          query = query.where('teams.id', 'in', [...scopes.teamIds])
        }
      }
      if (externalIds != null) {
        query = query.where(eb =>
          eb.exists(
            eb
              .selectFrom('external_ids')
              .select('external_ids.id')
              .where('external_ids.entity_type', '=', 'team')
              .whereRef('external_ids.entity_id', '=', 'teams.id')
              .where('external_ids.external_id', 'in', externalIds)
          )
        )
      }
      const nothing =
        inSeasons != null
          ? inSeasons.length === 0
          : !scopes.isAdmin && scopes.teamIds.size === 0
      const teams = nothing
        ? []
        : await query
            .groupBy([
              'teams.id',
              'teams.name',
              'teams.short_name',
              'teams.logo_path',
              'teams.kind'
            ])
            // A team has no season of its own to sort by — only a season
            // does — so the honest ordering is when it last played. The team
            // somebody is here to look at is almost always the one that
            // played last night. A team that has never played has no date,
            // and sorts to the bottom rather than to the top, which is where
            // SQL puts a null by default on a descending sort.
            .orderBy('lastPlayedAt', ob => ob.desc().nullsLast())
            .orderBy('teams.name')
            .execute()

      // A record is per season, read from the finished games' scores, so it
      // moves the moment a game does. The most recent season is the one a team
      // page shows.
      // Asked by season, a team's record is only from the seasons asked: the
      // caller may see those, and maybe none of the team's others.
      const counted = (
        await teamRecords(db, { teamIds: teams.map(team => team.id) })
      ).filter(
        record =>
          seasonsAsked == null ||
          (record.seasonId != null && seasonsAsked.includes(record.seasonId))
      )
      const seasonIds = [
        ...new Set(
          counted
            .map(record => record.seasonId)
            .filter((id): id is string => id != null)
        )
      ]
      const seasons =
        seasonIds.length === 0
          ? []
          : await db
              .selectFrom('seasons')
              .select(['id', 'name', 'year'])
              .where('id', 'in', seasonIds)
              .execute()
      const records = counted.map(record => {
        const season = seasons.find(row => row.id === record.seasonId)
        return {
          ...record,
          seasonName: season?.name ?? null,
          seasonYear: season?.year ?? null
        }
      })
      const newest = new Map<string, (typeof records)[number]>()
      for (const row of records) {
        const held = newest.get(row.teamId)
        if (held == null || (row.seasonYear ?? 0) > (held.seasonYear ?? 0)) {
          newest.set(row.teamId, row)
        }
      }

      res.json(
        teams.map(team => {
          const record = newest.get(team.id)
          return {
            id: team.id,
            name: team.name,
            shortName: team.short_name,
            logoPath: team.logo_path,
            logoUrl: imageUrl(media.space, team.logo_path),
            record:
              record == null || record.w + record.l + record.t === 0
                ? null
                : {
                    w: record.w,
                    l: record.l,
                    t: record.t,
                    seasonName: record.seasonName
                  },
            externalIds: team.externalIds ?? [],
            kind: team.kind
          }
        })
      )
    })
  )

  /** Refuses, as not there, a season the caller can neither see nor schedule. */
  async function mustSeeSeasons(
    db: Kysely<Database>,
    seasonIds: string[],
    userId: string,
    isAdmin: boolean,
    scopes: { seasonIds: Set<string> }
  ): Promise<void> {
    const found = await db
      .selectFrom('seasons')
      .select('id')
      .where('id', 'in', seasonIds)
      .execute()
    if (found.length !== new Set(seasonIds).size) throw notFound()
    if (isAdmin) return
    const unseen = seasonIds.filter(id => !scopes.seasonIds.has(id))
    if (unseen.length === 0) return
    const schedulable = await schedulableSeasonIds(db, userId, isAdmin)
    if (unseen.some(id => !schedulable.has(id))) throw notFound()
  }

  /**
   * The teams of these seasons, of the kind asked: their own full teams, the
   * external teams on either side of their games, or both. A merged team is
   * the team it was merged into, and each is listed once.
   */
  async function seasonTeamIds(
    db: Kysely<Database>,
    seasonIds: string[],
    kind: TeamKindAsked
  ): Promise<string[]> {
    // A season's own teams, and the external teams its games were played
    // against: a full team that played one of its games from outside it is
    // neither.
    const members = new Set<string>()
    const opponents = new Set<string>()
    if (kind !== 'external') {
      const rows = await db
        .selectFrom('season_teams')
        .select('team_id')
        .where('season_id', 'in', seasonIds)
        .where('active', '=', true)
        .execute()
      for (const row of rows) members.add(row.team_id)
    }
    if (kind !== 'full') {
      const games = await db
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id'])
        .where('season_id', 'in', seasonIds)
        .execute()
      for (const game of games) {
        opponents.add(game.home_team_id)
        opponents.add(game.away_team_id)
      }
    }
    const found = [...new Set([...members, ...opponents])]
    if (found.length === 0) return []
    // Read once; only a merged team needs its merges followed.
    const rows = await db
      .selectFrom('teams')
      .select(['id', 'kind', 'merged_into'])
      .where('id', 'in', found)
      .execute()
    const followed = new Set<string>()
    for (const row of rows) {
      if (!members.has(row.id) && row.kind !== 'external') continue
      followed.add(
        row.merged_into == null ? row.id : await followMerges(db, row.id)
      )
    }
    if (followed.size === 0) return []
    const wanted: Array<'full' | 'external'> =
      kind === 'any' ? ['full', 'external'] : [kind]
    const kept = await db
      .selectFrom('teams')
      .select('id')
      .where('id', 'in', [...followed])
      .where('kind', 'in', wanted)
      .execute()
    return kept.map(row => row.id)
  }

  /**
   * Makes a team, standalone or in a season, known by the ids another
   * system has for it. Anybody signed in may; the caller becomes the team's
   * administrator. Putting it in an existing season takes an administrator
   * of that season or its league. A body whose external id already names a
   * team the caller can see makes nothing and answers that team with 200.
   */
  router.post(
    '/teams',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const body = cleanBody(asCreateTeamBody, req.body)
      const answer = await createTeam(db, body, actor)

      setAudit(res.locals, {
        entityType: 'team',
        entityId: answer.id,
        after: answer.created
          ? {
              name: answer.name,
              seasonId: answer.season?.id ?? null,
              seasonCreated: answer.season?.created ?? false,
              externalIds: body.externalIds
            }
          : undefined
      })
      res.status(answer.created ? 201 : 200).json(answer)
    })
  )

  router.get(
    '/teams/:teamId/games',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      const outside = await nonMemberTeam(db, actor, scopes, teamId)
      if (!outside && !canSeeTeam(scopes, teamId)) throw notFound()

      const rows = await scheduleOf(db, media, {
        teamId,
        actor,
        gamesOnly: outside,
        // A non-member sees this team's games as if it were their only team,
        // and nothing their own scopes would add.
        visible: outside
          ? { teamIds: new Set([teamId]), seasonIds: new Set(), isAdmin: false }
          : scopes
      })
      const attendance = outside
        ? new Map<string, PlayerRsvpCounts>()
        : await teamPlayerRsvps(
            db,
            teamId,
            rows.filter(row => !row.pendingApproval)
          )
      res.json(
        rows.map(({ homeLogoPath, awayLogoPath, ...row }) => ({
          ...row,
          ...(attendance.has(row.id)
            ? { playerRsvps: attendance.get(row.id) }
            : {}),
          homeLogoUrl: imageUrl(media.space, homeLogoPath),
          awayLogoUrl: imageUrl(media.space, awayLogoPath)
        }))
      )
    })
  )

  router.get(
    '/games/:gameId',
    // The scoreboard is asked of Redis after the reads have committed, so
    // the transaction does not hold a connection through that call.
    withRevisionThen(db, async (db, req, res) => {
      const actor = req.actor
      const gameId = pathParam(req.params.gameId)
      const event =
        actor == null ? null : await teamEventDetail(db, actor, gameId)
      if (event != null) {
        res.json(event)
        return async () => undefined
      }
      const scopes =
        actor == null
          ? null
          : await visibleScopes(db, actor.userId, actor.isAdmin)

      const game = await db
        .selectFrom('games')
        .selectAll()
        .select(resolvedFenceDistance.as('resolved_fence_distance_ft'))
        .select(hasScoringEventsSql.as('hasScoringEvents'))
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()
      const scope = {
        homeTeamId: game.home_team_id,
        awayTeamId: game.away_team_id,
        seasonId: game.season_id
      }
      // Games are public: members of either side or its season get the
      // full detail, and everybody else gets the non-member view.
      const nonMemberView = scopes == null || !canSeeGame(scopes, scope)

      const videos = await db
        .selectFrom('videos')
        .select([
          'id',
          'kind',
          'title',
          'status',
          'storage',
          'start_at',
          'duration_sec',
          'width',
          'height',
          'codecs',
          'num_cameras',
          'sync_offset_sec'
        ])
        .where('game_id', '=', gameId)
        .where('hidden', '=', false)
        .where(isRealVideo)
        // As they arrived. `kind` sorted them alphabetically, which put
        // `combined` first — so the mosaic led the picker, and "the first
        // four" would tick the very thing the multi-camera view replaces into
        // the top-left quadrant. `created_at` on its own is import time rather
        // than upload order, and a camera backfilled a week late would sort a
        // week after its siblings, so the recording's own start wins where it
        // has one.
        .orderBy(sql`coalesce(start_at, created_at)`)
        .orderBy('id')
        .execute()
      const receiving = await receivingVideoIds(
        db,
        videos.filter(video => video.status === 'live').map(video => video.id)
      )

      // Whether this caller runs the game, and so may override its scoreboard:
      // a manager of either side or anybody above one. It needs no Redis.
      const editors =
        actor == null
          ? null
          : await adminScopes(db, actor.userId, actor.isAdmin)
      const mayOverride =
        editors != null &&
        (canManageTeam(editors, game.home_team_id) ||
          canManageTeam(editors, game.away_team_id))

      const names = await teamNames(db, [game.home_team_id, game.away_team_id])
      // Whether to offer Score Game: a scorekeeper of either team, which
      // every administrator of it is. The events route holds the same rule.
      // And whether to offer DJ Game: a songkeeper of either team, which
      // every scorekeeper is. And the sides whose lineups this caller saves
      // as their team's head coach, as the lineups route allows.
      const roles =
        actor == null ? null : await roleScopes(db, actor.userId, actor.isAdmin)

      // Each side's record in the season this game was played in.
      const recordRows = await teamRecords(db, {
        teamIds: [game.home_team_id, game.away_team_id],
        seasonId: game.season_id
      })
      const logos = await db
        .selectFrom('teams')
        .select(['id', 'logo_path'])
        .where('id', 'in', [game.home_team_id, game.away_team_id])
        .execute()
      const logoOf = (teamId: string): string | null =>
        imageUrl(
          media.space,
          logos.find(row => row.id === teamId)?.logo_path ?? null
        )

      const recordOf = (teamId: string): string | null => {
        const row = recordRows.find(item => item.teamId === teamId)
        if (row == null || row.w + row.l + row.t === 0) return null
        return row.t > 0 ? `${row.w}–${row.l}–${row.t}` : `${row.w}–${row.l}`
      }

      // The frames the card and the picker are about to ask for.
      warmPosters(
        media,
        videos
          .filter(video => video.status === 'ready')
          .map(video => ({
            gameId,
            videoId: video.id,
            storage: video.storage,
            durationSec: video.duration_sec
          }))
      ).catch(() => undefined)

      const [pending] = annotatePending(
        [game],
        await pendingSchedule(db, actor, new Date(), {
          publishedGameIds: [game.id],
          includeNew: false
        })
      )
      const assigned =
        actor == null || nonMemberView
          ? undefined
          : await givenRolesOnTeams(db, [game.away_team_id, game.home_team_id])
      const availability = await gameAvailability(db, game)
      const answer = {
        id: game.id,
        umpires: await gameUmpires(db, game.id, media),
        guests: availability.guests,
        unrostered: availability.unrostered,
        guestPlayers:
          actor == null || nonMemberView
            ? { away: [], home: [] }
            : availability.guestPlayers,
        pendingApproval: pending.pendingApproval,
        pendingRequestId: pending.pendingRequestId,
        homeTeamId: game.home_team_id,
        awayTeamId: game.away_team_id,
        // Which set of plays the game holds: one more after each reset.
        generation: game.play_generation,
        homeTeamName: names.get(game.home_team_id) ?? '',
        awayTeamName: names.get(game.away_team_id) ?? '',
        seasonId: game.season_id,
        startAt: toIso(game.start_at),
        venue: game.venue,
        endAt: toIso(game.end_at),
        address: game.address,
        notes: nonMemberView ? null : game.notes,
        arrivalTimeDelta: nonMemberView ? null : game.arrival_time_delta,
        eventType: 'game',
        latitude: game.latitude,
        longitude: game.longitude,
        hasScoringEvents: game.hasScoringEvents,
        isGameLive: gameIsLive({
          startAt: toIso(game.start_at),
          endAt: toIso(game.end_at),
          status: game.status,
          hasScoringEvents: game.hasScoringEvents
        }),
        exhibition: game.exhibition,
        timezone: game.timezone,
        cancellationReason: game.cancellation_reason,
        withdrawnByTeamId: game.withdrawn_by_team_id,
        withdrawnByTeamName:
          game.withdrawn_by_team_id == null
            ? null
            : ((await teamNames(db, [game.withdrawn_by_team_id])).get(
                game.withdrawn_by_team_id
              ) ?? null),
        status: game.status,
        homeScore: game.home_score,
        awayScore: game.away_score,
        ingestStatus: game.ingest_status,
        ingestMessage: nonMemberView ? null : game.ingest_message,
        scoringOwner: nonMemberView ? null : game.scoringOwner,
        awayRecord: recordOf(game.away_team_id),
        homeRecord: recordOf(game.home_team_id),
        awayLogoUrl: logoOf(game.away_team_id),
        homeLogoUrl: logoOf(game.home_team_id),
        // A non-member reads the runs, by inning and in all, and none of the
        // totals the box score is made of.
        linescore: nonMemberView
          ? withoutTotals(game.linescore)
          : game.linescore,
        fenceDistanceFt: Number(game.resolved_fence_distance_ft),
        assignedRoles: {
          away: assigned?.get(game.away_team_id)?.get(actor!.userId) ?? [],
          home: assigned?.get(game.home_team_id)?.get(actor!.userId) ?? []
        },
        canScore:
          !nonMemberView &&
          roles != null &&
          (canScore(roles, game.home_team_id) ||
            canScore(roles, game.away_team_id)),
        canDj:
          !nonMemberView &&
          roles != null &&
          (canKeepSongs(roles, game.home_team_id) ||
            canKeepSongs(roles, game.away_team_id)),
        coachSides:
          nonMemberView || roles == null
            ? []
            : (['away', 'home'] as const).filter(side =>
                isHeadCoach(
                  roles,
                  side === 'home' ? game.home_team_id : game.away_team_id
                )
              ),
        // Whether this is the non-member view, so the app draws it as one.
        nonMemberView,
        // Whether anything TeamStation scored is stored, so it can be
        // replayed: a recorded play, or a recorded at-bat in progress.
        replayable: await hasRecordedPlays(db, gameId, game.currentPlay),
        scoreboard: null as Awaited<ReturnType<typeof scoreboardOf>>,
        videos: videos.map(video => ({
          id: video.id,
          numCameras: video.num_cameras,
          syncOffsetSec: video.sync_offset_sec,
          posterUrl:
            video.status === 'ready'
              ? posterUrl(media, video.id, posterSecond(video.duration_sec))
              : null,
          kind: video.kind,
          title: video.title,
          status: video.status,
          receiving: receiving.has(video.id),
          storage: video.storage,
          startAt: toIso(video.start_at),
          durationSec: video.duration_sec,
          width: video.width,
          height: video.height,
          codecs: video.codecs
        }))
      }
      return async () => {
        if (!nonMemberView)
          answer.scoreboard = await scoreboardOf(store, mayOverride, {
            startAt: new Date(game.start_at).getTime(),
            status: game.status,
            gameId
          })
        res.json(answer)
      }
    })
  )

  router.get(
    '/videos/:videoId/highlights',
    withAsync(async (req, res) => {
      const videoId = pathParam(req.params.videoId)

      const video = await db
        .selectFrom('videos')
        .innerJoin('games', 'games.id', 'videos.game_id')
        .select([
          'videos.id as id',
          'videos.game_id as gameId',
          'videos.storage as storage',
          'videos.start_at as startAt',
          'videos.sync_offset_sec as syncOffsetSec',
          'videos.duration_sec as durationSec',
          'videos.hidden as hidden',
          'games.ingest_status as ingestStatus'
        ])
        .where('videos.id', '=', videoId)
        .executeTakeFirst()
      // Anybody reads a game's highlights and their stills, a
      // member as part of the game and anybody else in the non-member view;
      // the video they seek into is for members. A video that is not there,
      // or hidden, is 404, as it is for playback.
      if (video == null || video.hidden) throw notFound()

      // A game whose plays did not add up is not offered as highlights until a
      // manager has accepted it: a wrong seek is worse than none.
      if (video.ingestStatus === 'scoreMismatch') {
        res.json({ withheld: 'scoreMismatch', highlights: [] })
        return
      }

      const events = await db
        .selectFrom('events')
        .select(HIGHLIGHT_EVENT_COLUMNS)
        .where('gameId', '=', video.gameId)
        .orderBy('atBatIndex')
        .execute()

      const credits = await creditsForHighlight(
        db,
        events.map(row => row.id)
      )
      // Each credit names its people by id, read from the game's book.
      const gameId = video.gameId ?? ''
      const book = (await gameNames(db, [gameId])).get(gameId)
      const nameOf = book?.nameOf ?? ((): undefined => undefined)
      const teams = await teamStandings(db)

      const settings = await highlightSettings(db)
      const computed = withDropped(
        // `undefined` keeps a play nobody has looked at; `[]` drops one that
        // was looked at and credited to nobody.
        events.map(row => highlightEvent(row, credits.get(row.id), nameOf)),
        {
          startAt: video.startAt == null ? null : new Date(video.startAt),
          syncOffsetSec: video.syncOffsetSec,
          durationSec: video.durationSec
        },
        settings,
        teams
      )
      const highlights = computed.highlights

      // A still is one frame of the video at the moment of the play, kept in
      // the Space beside the video and handed out as a signed URL to the API,
      // which redirects to it.
      const now = Date.now()
      const withStills = highlights.map(highlight => ({
        ...highlight,
        stillUrl: stillUrl(media, videoId, highlight.playOffsetSec, now)
      }))

      res.json({
        withheld: whyEmpty(highlights, events, video),
        // How many plays were left out because nobody could be named on them.
        // An empty list can then say which kind of empty it is.
        droppedCount: computed.dropped,
        highlights: withStills
      })

      // Answered first, then the frames are cut. The plan has ingest pre-warm
      // these; until a game can be ingested with its video already in place,
      // opening the list is what warms it, and a still that is not ready yet
      // is a missing thumbnail rather than a slow response.
      warmVideoStills(media, video.storage, videoId, highlights).catch(
        () => undefined
      )
    })
  )

  /**
   * Who is on a team.
   *
   * Players first and then everybody else, because the roster screen is read
   * by parents looking for one child. A person with no jersey still belongs on
   * the list — a late addition has a name before it has a number.
   */
  router.get(
    '/teams/:teamId/roster',
    requireActor,
    withRevision(db, async (db, req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const fullNames = req.query.includeFullNames
      if (
        fullNames !== undefined &&
        fullNames !== 'true' &&
        fullNames !== 'false'
      )
        throw badRequest('includeFullNames must be true or false')
      if (fullNames === 'true') {
        const roles = await roleScopes(db, actor.userId, actor.isAdmin)
        if (!canManageRoster(roles, teamId)) throw notFound()
      }
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (canSeeTeam(scopes, teamId)) {
        res.json(
          await teamRoster(db, media.space, teamId, fullNames === 'true')
        )
        return
      }
      if (!(await nonMemberTeam(db, actor, scopes, teamId))) throw notFound()
      // Staff imagery is public; other people's faces and family links are not.
      const roster = await teamRoster(db, media.space, teamId)
      res.json(
        roster.map(entry => ({
          ...entry,
          avatarUrl:
            entry.section === 'admin' || entry.section === 'staff'
              ? entry.avatarUrl
              : null,
          guardianOf: undefined
        }))
      )
    })
  )

  /**
   * A team's batting and pitching across a season.
   *
   * Added up from the stored stat lines, which is where every figure on the
   * site comes from: one row per player per game, counted by walking the game
   * stream the way a scorebook does. A figure here and the same figure in a box
   * score are sums of the same rows, so they cannot disagree.
   */
  router.get(
    '/teams/:teamId/stats',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (!canSeeTeam(scopes, teamId)) {
        if (await nonMemberTeam(db, actor, scopes, teamId)) throw membersOnly()
        throw notFound()
      }

      const seasonId =
        typeof req.query.seasonId === 'string' ? req.query.seasonId : undefined

      const rows = await statRows(db, { teamId, seasonId })
      const names = shortNames(
        rows.map(row => ({
          id: row.userId,
          firstName: row.firstName,
          lastName: row.lastName,
          displayName: row.displayName
        }))
      )

      if (req.query.kind === 'pitching') {
        res.json(
          pitchingLines(rows).map(line => ({
            ...line,
            shortName: names.get(line.userId) ?? 'Unknown',
            ip: inningsPitched(line.outs),
            rates: pitchingRates(line)
          }))
        )
        return
      }
      res.json(
        battingLines(rows).map(line => ({
          ...line,
          shortName: names.get(line.userId) ?? 'Unknown',
          rates: battingRates(line)
        }))
      )
    })
  )

  router.get(
    '/games/:gameId/box-score',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const game = await db
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id', 'season_id'])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()
      const scope = {
        homeTeamId: game.home_team_id,
        awayTeamId: game.away_team_id,
        seasonId: game.season_id
      }
      // Anybody signed in reads the game, so it is no secret: the lines are
      // for members.
      if (!canSeeGame(scopes, scope)) throw membersOnly()

      const rows = await statRows(db, { gameId })
      const names = shortNames(
        rows.map(row => ({
          id: row.userId,
          firstName: row.firstName,
          lastName: row.lastName,
          displayName: row.displayName
        }))
      )

      // The average beside a name is read as what kind of hitter somebody is,
      // so it is their season to date rather than their afternoon: three
      // at-bats say nothing, and a box score has always printed the running
      // figure.
      const seasonAvg = await averagesToDate(db, gameId, game.season_id, scopes)

      const pitching = (
        await pitchingOrder(db, gameId, pitchingLines(rows))
      ).map(line => ({
        ...line,
        shortName: names.get(line.userId) ?? 'Unknown',
        ip: inningsPitched(line.outs),
        rates: pitchingRates(line)
      }))
      const lines = await boxScoreOrder(db, gameId, battingLines(rows))

      res.json({
        batting: lines.map(line => ({
          ...line,
          shortName: names.get(line.userId) ?? 'Unknown',
          rates: battingRates(line),
          seasonAvg: seasonAvg.get(line.userId) ?? null
        })),
        pitching,
        stats: await gameStatsStatus(db, gameId)
      })
    })
  )

  return router
}

/**
 * Whether a game's scoreboard is open, and whether this caller may override
 * it: null when there is no store or Redis is away, which leaves the
 * Scoreboard option on the Score Game screen unavailable. Whoever may score
 * the game may override its board.
 */
async function scoreboardOf(
  store: ScoreboardStore | undefined,
  mayScore: boolean,
  game: { gameId: string; startAt: number; status: string }
): Promise<{ open: boolean; mayOverride: boolean } | null> {
  if (store == null) return null
  let keyExists: boolean
  try {
    keyExists = await store.exists(game.gameId)
  } catch (error) {
    if (error instanceof ScoreboardUnavailable) return null
    throw error
  }
  return {
    open: scoreboardOpen(game, keyExists, store.now()),
    mayOverride: mayScore
  }
}

/**
 * A stored line score as a non-member reads it: each side's runs by inning and
 * in all, with its hits, errors, walks, strikeouts, home runs and hit batters
 * left null, as a game whose plays cannot say them reads.
 */
function withoutTotals(linescore: unknown): unknown {
  if (linescore == null) return null
  const { away, home } = linescore as { away: object; home: object }
  return { away: { ...away, ...WITHHELD }, home: { ...home, ...WITHHELD } }
}

const WITHHELD = { h: null, e: null, bb: null, k: null, hr: null, hbp: null }

/**
 * Express 5 types a path parameter as `string | string[]`, because a route can
 * repeat one. None of ours do, so anything else is a malformed URL and gets
 * the same 404 as an id that does not exist.
 */
function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}

/**
 * Each batter's average for the season, up to and including this game.
 *
 * The average printed beside a name in a box score is read as what kind of
 * hitter somebody is, and one afternoon does not say. So it is counted over
 * each currently visible game of the same season up to this one. For a game
 * with no season, only visible games involving these teams contribute.
 */
async function averagesToDate(
  db: Kysely<Database>,
  gameId: string,
  seasonId: string | null,
  scopes: VisibleScopes
): Promise<Map<string, number>> {
  const game = await db
    .selectFrom('games')
    .select(['start_at', 'home_team_id', 'away_team_id'])
    .where('id', '=', gameId)
    .executeTakeFirst()
  if (game == null) return new Map()

  const rows = await statRows(db, {
    visibleGames: scopes,
    seasonId: seasonId ?? undefined,
    // A one-off belongs to no season, and the only honest answer for it is
    // visible games these two teams have played.
    teamIds:
      seasonId == null ? [game.home_team_id, game.away_team_id] : undefined,
    // Up to and including this one, by when it was played. A game with no date
    // cannot be placed in the order, so it counts only for its own box score.
    playedBy: game.start_at == null ? undefined : new Date(game.start_at)
  })

  const out = new Map<string, number>()
  for (const line of battingLines(rows)) {
    if (line.ab > 0) out.set(line.userId, line.h / line.ab)
  }
  return out
}
