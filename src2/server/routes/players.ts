import { Router } from 'express'
import { type Kysely, sql } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { shortName } from '../../common/names'
import { type CreditedOutcomeLike, outcomeName } from '../../common/outcomes'
import { mayEditName, visibleScopes } from '../access'
import { onePerson } from '../admin/people'
import type { Database } from '../db/database'
import { isRealVideo } from '../db/realVideos'
import { teamNames, teamStandings } from '../db/teamLookups'
import { withDropped } from '../highlights'
import { imageUrl, PROFILE_SIZE } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { mediaUrlPath } from '../media/mediaTokens'
import { stillSecond } from '../media/stills'
import { warmVideoStills } from '../media/videoStills'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { highlightSettings } from '../settings'

/**
 * One person: their picture, their name, how they bat and throw, and the teams
 * they have played for.
 *
 * The teams travel with the person because the filter on their stats is built
 * from them — season, team and year are exactly the three things this list
 * knows — so narrowing a page costs no second request.
 *
 * **No jersey number here.** A number belongs to a player *on a team*
 * (`memberships.jersey`) and is drawn where that context exists: the team's
 * roster, and the box score. Sending it from an endpoint about a person is how
 * it ends up on a card that has to choose between a child's two numbers.
 */
export function playerRoutes(
  db: Kysely<Database>,
  media: MediaContext
): Router {
  const router = Router()

  router.get(
    '/players/:userId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = pathParam(req.params.userId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)

      const user = await db
        .selectFrom('users')
        .select([
          'id',
          'display_name as displayName',
          'first_name as firstName',
          'last_name as lastName',
          'avatar_path as avatarPath',
          'bats',
          'throws',
          'merged_into as mergedInto'
        ])
        .where('id', '=', userId)
        .executeTakeFirst()
      if (user == null) throw notFound()

      // A merged account is closed rather than deleted, and its plays now
      // belong to the person it was merged into. Follow the link rather than
      // showing a page whose stats moved out from under it.
      if (user.mergedInto != null) {
        res.redirect(
          303,
          `/api/v1/players/${encodeURIComponent(user.mergedInto)}`
        )
        return
      }

      const teams = await teamsOf(db, userId)

      // The same rule as every other read: you may see somebody if you can
      // already see a team they are on, or a season opened up to you. Their
      // own page is always theirs.
      const visible =
        scopes.isAdmin ||
        userId === actor.userId ||
        teams.some(
          team =>
            scopes.teamIds.has(team.teamId) ||
            (team.seasonId != null && scopes.seasonIds.has(team.seasonId))
        )
      if (!visible) throw notFound()

      // `Jensen P`, for everybody, always. There is no viewer who gets the
      // whole name because of who they are: this endpoint does not know how to
      // send one. The surname lives behind `/name` below, which is the field
      // you type it into rather than a page you read.
      const mayEdit = await mayEditName(db, actor.userId, userId, {
        isAdmin: actor.isAdmin
      })

      res.json({
        userId,
        name: shortName({ ...user, id: userId }),
        /** Whether to offer this person the name field at all. */
        canEditName: mayEdit,
        avatarUrl: imageUrl(media.space, user.avatarPath, PROFILE_SIZE),
        bats: user.bats,
        throws: user.throws,
        teams: teams.filter(
          team =>
            scopes.isAdmin ||
            userId === actor.userId ||
            scopes.teamIds.has(team.teamId) ||
            (team.seasonId != null && scopes.seasonIds.has(team.seasonId))
        )
      })
    })
  )

  /**
   * The name in full, for the one thing it is for: changing it.
   *
   * A separate request, deliberately, so that reading a player's page cannot
   * carry a surname to a screen by accident. A parent or an administrator
   * opening the name field asks for it; everybody else is answered 404, and
   * the page they were reading never had it.
   */
  router.get(
    '/players/:userId/name',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = pathParam(req.params.userId)

      const mayEdit = await mayEditName(db, actor.userId, userId, {
        isAdmin: actor.isAdmin
      })
      if (!mayEdit) throw notFound()

      const user = await db
        .selectFrom('users')
        .select([
          'id',
          'display_name as displayName',
          'first_name as firstName',
          'last_name as lastName'
        ])
        .where('id', '=', userId)
        .executeTakeFirst()
      if (user == null) throw notFound()

      res.json({
        userId,
        displayName: user.displayName,
        firstName: user.firstName,
        lastName: user.lastName
      })
    })
  )

  /**
   * Every highlight this player is credited on, across every game they have
   * ever played, newest first.
   *
   * The opposite question from the one a game asks. A game's highlights are
   * every play in one video; these are one person's plays in forty videos, so
   * the work is done the other way round: find the plays, group them by the
   * video that covers them, and run the same timing arithmetic per video.
   *
   * The timing is not reimplemented here. `withDropped` holds the lag, the
   * per-event lead, the nudge and the video's own clock correction — four
   * settings that move together — and a second copy of that arithmetic is a
   * second answer to where a play is.
   */
  router.get(
    '/players/:userId/highlights',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = pathParam(req.params.userId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      const limit = limitOf(req.query.limit)
      const before = dateOf(req.query.before)

      // Every row that is this person, because a merge closes a row without
      // moving what was written under it.
      const person = await onePerson(db, userId)

      // The plays this person is credited on. The credit is what the row is
      // drawn from, so the credit is what is searched: `event_players` says
      // somebody was named on a play, which is not the same as somebody having
      // done something worth watching.
      let query = db
        .selectFrom('events')
        .innerJoin('games', 'games.id', 'events.game_id')
        .select([
          'events.id as eventId',
          'events.game_id as gameId',
          'events.at_bat_index as atBatIndex',
          'events.start_time as startTime',
          'events.event_type as eventType',
          'events.description as description',
          'events.title_override as titleOverride',
          'events.time_nudge_sec as timeNudgeSec',
          'events.hidden as hidden',
          'events.is_scoring_play as isScoringPlay',
          'events.credits as credits',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'games.season_id as seasonId',
          'games.ingest_status as ingestStatus'
        ])
        .where('events.hidden', '=', false)
        .where('events.start_time', 'is not', null)
        // Containment against the credits themselves, which is what the GIN
        // index in `022creditIndex` answers. Kysely has no builder for `@>`,
        // and every id is bound rather than pasted into the string.
        .where(eb =>
          eb.or(
            person.userIds.map((id: string) =>
              eb(
                sql<boolean>`events.credits @> jsonb_build_array(jsonb_build_object('creditUserId', ${id}::text))`,
                '=',
                true
              )
            )
          )
        )
      if (before != null) {
        query = query.where('events.start_time', '<', before)
      }

      const rows = await query
        .orderBy('events.start_time', 'desc')
        // One extra, so the page knows whether there is another without
        // counting every play this child has ever been part of.
        .limit(limit + 1)
        .execute()

      const seen = rows.filter(
        row =>
          scopes.isAdmin ||
          person.userIds.includes(actor.userId) ||
          scopes.teamIds.has(row.homeTeamId) ||
          scopes.teamIds.has(row.awayTeamId) ||
          (row.seasonId != null && scopes.seasonIds.has(row.seasonId))
      )
      const page = seen.slice(0, limit)
      const hasMore = seen.length > limit

      // A game whose plays did not add up is not offered as highlights until
      // somebody has accepted it: a wrong seek is worse than none. The same
      // rule the game's own highlight list follows.
      const usable = page.filter(row => row.ingestStatus !== 'scoreMismatch')

      const videos =
        usable.length === 0
          ? []
          : await db
              .selectFrom('videos')
              .select([
                'id',
                'game_id as gameId',
                'kind',
                'storage',
                'start_at as startAt',
                'sync_offset_sec as syncOffsetSec',
                'duration_sec as durationSec'
              ])
              .where(
                'game_id',
                'in',
                usable.map(row => row.gameId)
              )
              .where(isRealVideo)
              .orderBy('kind')
              .execute()

      const settings = await highlightSettings(db)
      const standings = await teamStandings(db)
      const names = await teamNames(
        db,
        page.flatMap(row => [row.homeTeamId, row.awayTeamId])
      )

      interface Row {
        eventId: string
        gameId: string
        videoId: string
        teamId: string | null
        teamName: string | null
        outcome: string
        playAt: string
        startOffsetSec: number
        playOffsetSec: number
        stillUrl: string
        storage: 'peertube' | 'local' | 'spaces'
      }
      const now = Date.now()
      const out: Row[] = []

      for (const row of usable) {
        const credits = (row.credits ?? []) as CreditedOutcomeLike[]
        // The play's credits for this person, by any of their rows.
        const mine = credits.filter(outcome => {
          const held = outcome as { creditUserId?: string | null }
          return (
            held.creditUserId != null &&
            person.userIds.includes(held.creditUserId)
          )
        })
        if (mine.length === 0) continue

        // The video that was running when the play happened. The programme
        // recording first, which is the one a game is normally watched on.
        for (const video of videos.filter(item => item.gameId === row.gameId)) {
          const computed = withDropped(
            [
              {
                id: row.eventId,
                atBatIndex: row.atBatIndex,
                startTime:
                  row.startTime == null ? null : new Date(row.startTime),
                eventType: row.eventType,
                description: row.description,
                titleOverride: row.titleOverride,
                timeNudgeSec: row.timeNudgeSec,
                hidden: row.hidden,
                isScoringPlay: row.isScoringPlay,
                credits: credits as never
              }
            ],
            {
              startAt: video.startAt == null ? null : new Date(video.startAt),
              syncOffsetSec: video.syncOffsetSec,
              durationSec: video.durationSec
            },
            settings,
            standings
          )
          const highlight = computed.highlights[0]
          if (highlight == null) continue

          const outcome = mine[0]
          const teamId = (outcome as { teamId?: string | null }).teamId ?? null
          out.push({
            eventId: row.eventId,
            gameId: row.gameId,
            videoId: video.id,
            teamId,
            teamName: teamId == null ? null : (names.get(teamId) ?? null),
            outcome: outcomeName(outcome),
            playAt: highlight.playAt.toISOString(),
            startOffsetSec: highlight.startOffsetSec,
            playOffsetSec: highlight.playOffsetSec,
            stillUrl:
              media.publicUrl +
              mediaUrlPath(
                media.mediaSecret,
                `work/stills/${video.id}`,
                `${stillSecond(highlight.playOffsetSec)}.jpg`,
                now
              ),
            storage: video.storage
          })
          // One row per play: the first video that covers it is the one the
          // list opens, and the same moment twice is two thumbnails of one
          // piece of video.
          break
        }
      }

      res.json({
        highlights: out.map(({ storage, ...rest }) => rest),
        /** The play time to ask for the next page from. */
        nextBefore:
          hasMore && page.length > 0
            ? new Date(page[page.length - 1].startTime!).toISOString()
            : null,
        /**
         * Plays of theirs that no recording covers. Counted rather than shown:
         * `no highlights` and `no camera was there` are different answers, and
         * a child who played all season reads the first as being left out.
         */
        withoutVideo: page.length - out.length
      })

      // Answered first, then the frames are cut, and only for the page just
      // sent. Cutting two hundred stills to draw a list somebody scrolls five
      // rows of is a minute of a server's life spent on nothing.
      const byVideo = new Map<string, Row[]>()
      for (const row of out) {
        const held = byVideo.get(row.videoId)
        if (held == null) byVideo.set(row.videoId, [row])
        else held.push(row)
      }
      for (const [videoId, rows_] of byVideo) {
        warmVideoStills(media, rows_[0].storage, videoId, rows_).catch(
          () => undefined
        )
      }
    })
  )

  return router
}

/** Twenty at a time, and never more than fifty however hard somebody asks. */
function limitOf(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 20
  return Math.min(Math.floor(value), 50)
}

function dateOf(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export interface PlayerTeam {
  teamId: string
  teamName: string
  seasonId: string | null
  seasonName: string | null
  seasonYear: number | null
}

/**
 * Every team this person has played for, and in which season.
 *
 * Two sources, because neither is complete on its own: a membership is a team
 * they were put on, and a stats row is a team they actually batted for. A
 * child imported from a roster has the first without the second until their
 * games are ingested; a child who appears only in an opponent's play-by-play
 * can have the second without the first.
 */
export async function teamsOf(
  db: Kysely<Database>,
  userId: string
): Promise<PlayerTeam[]> {
  const fromMemberships = await db
    .selectFrom('memberships')
    .innerJoin('teams', 'teams.id', 'memberships.team_id')
    .leftJoin('season_teams', 'season_teams.team_id', 'memberships.team_id')
    .leftJoin('seasons', 'seasons.id', 'season_teams.season_id')
    .select([
      'memberships.team_id as teamId',
      'teams.name as teamName',
      'seasons.id as seasonId',
      'seasons.name as seasonName',
      'seasons.year as seasonYear'
    ])
    .where('memberships.user_id', '=', userId)
    .where('memberships.is_player', '=', true)
    .where('teams.merged_into', 'is', null)
    .execute()

  const fromPlays = await db
    .selectFrom('player_season_stats')
    .innerJoin('teams', 'teams.id', 'player_season_stats.team_id')
    .leftJoin('seasons', 'seasons.id', 'player_season_stats.season_id')
    .select([
      'player_season_stats.team_id as teamId',
      'teams.name as teamName',
      'seasons.id as seasonId',
      'seasons.name as seasonName',
      'seasons.year as seasonYear'
    ])
    .where('player_season_stats.user_id', '=', userId)
    .where('teams.merged_into', 'is', null)
    .execute()

  const byKey = new Map<string, PlayerTeam>()
  for (const row of [...fromPlays, ...fromMemberships]) {
    byKey.set(`${row.teamId} ${row.seasonId ?? ''}`, row)
  }

  // Newest season first, and a team with no season at the end: a page opens on
  // what somebody is doing now, not on what they did three years ago.
  return [...byKey.values()].sort((a, b) => {
    const byYear = (b.seasonYear ?? 0) - (a.seasonYear ?? 0)
    if (byYear !== 0) return byYear
    return a.teamName.localeCompare(b.teamName)
  })
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
