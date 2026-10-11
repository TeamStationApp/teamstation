import { Router } from 'express'
import type { Kysely } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { shortName } from '../../common/names'
import { outcomeName } from '../../common/outcomes'
import { asPersonSettings, asPlayerSettings } from '../../common/playerSettings'
import { asUserId } from '../../common/userIdNumber'
import {
  canSeePerson,
  canSeePlayedFor,
  guardsPerson,
  mayEditName,
  mayManagePlayer,
  teamsPlayedOnNow,
  visibleScopes
} from '../access'
import { onePerson } from '../admin/people'
import type { Database } from '../db/database'
import { isRealVideo } from '../db/realVideos'
import { teamNames, teamStandings } from '../db/teamLookups'
import { creditsForPlayer } from '../events/credits'
import { guardianInviteAs } from '../groups/requests'
import {
  HIGHLIGHT_EVENT_COLUMNS,
  highlightEvent,
  withDropped
} from '../highlights'
import { cleanBody } from '../jsonBody'
import { imageUrl, PROFILE_SIZE } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { stillUrl } from '../media/stills'
import { warmVideoStills } from '../media/videoStills'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { highlightSettings } from '../settings'
import { playerFilterOf } from '../stats/rows'
import { teamRoster } from '../teams/teamRoster'

/**
 * One person: their picture, their name, how they bat and throw, and the teams
 * they have played for.
 *
 * The teams travel with the person because the filter on their stats is built
 * from them — season, team and year are exactly the three things this list
 * knows — so narrowing a page costs no second request.
 *
 * **No jersey number on the person.** A number belongs to a player *on a
 * team* (`memberships.jersey`), so it travels only inside a `teams[]` row,
 * beside the team it was worn for, with that team's positions. Nothing about
 * the person carries one: that is how a number ends up on a card that has to
 * choose between a child's two.
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
      const userId = userIdParam(req.params.userId)
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

      const person = await onePerson(db, userId)
      const teams = await teamsOf(db, person.userIds)

      // The same rule as every other read: you may see somebody if you can
      // already see a team they are on, or a season opened up to you. Their
      // own page is always theirs, and their guardian's: every team they
      // have played for, the ones they have left included.
      const ownPage =
        userId === actor.userId ||
        (await guardsPerson(db, scopes, actor.userId, person))
      if (!canSeePerson(scopes, ownPage, teams)) {
        throw notFound()
      }

      // `Jordan P` for everybody, whoever is asking. The whole name is never
      // in this answer: it is only behind `/name` below, for the person
      // editing it, which `mayEditName` decides.
      const mayEdit = await mayEditName(
        db,
        actor.userId,
        userId,
        { isAdmin: actor.isAdmin },
        { player: person }
      )

      res.json({
        userId,
        name: shortName({ ...user, id: userId }),
        /** Whether to offer this person the name field at all. */
        canEditName: mayEdit,
        /**
         * How this person may invite a guardian of the player: as a guardian,
         * with no sending team; from a team they coach, while the player has
         * no guardian; or not at all.
         */
        guardianInviteAs: await guardianInviteAs(db, actor, userId),
        avatarUrl: imageUrl(media.space, user.avatarPath, PROFILE_SIZE),
        bats: user.bats,
        throws: user.throws,
        teams: teams
          .filter(team => ownPage || canSeePlayedFor(scopes, team))
          .map(({ logoPath, ...team }) => ({
            ...team,
            logoUrl: imageUrl(media.space, logoPath)
          }))
      })
    })
  )

  /**
   * The name in full, for the one thing it is for: changing it.
   *
   * A separate request, deliberately, so that reading a player's page cannot
   * carry a surname to a screen by accident. A parent, the team's staff or
   * a site administrator opening the name field asks for it; everybody else
   * is answered 404, and the page they were reading never had it.
   */
  router.get(
    '/players/:userId/name',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = userIdParam(req.params.userId)

      const person = await onePerson(db, userId)
      const mayEdit = await mayEditName(
        db,
        actor.userId,
        userId,
        { isAdmin: actor.isAdmin },
        { player: person }
      )
      if (!mayEdit) throw notFound()

      // A closed row's name is not the one anybody should be editing: send
      // the editor on to the row still open, as the player page does. Only
      // after the check above, so a refused asker gets the same 404 for a
      // closed row as for an open one, and learns nothing of who may ask.
      // A cycle, or a chain longer than `onePerson` walks, ends on a row that
      // is still closed; sending the editor there would go round in circles,
      // so the row asked about answers for itself.
      if (person.userId !== userId) {
        const end = await db
          .selectFrom('users')
          .select(['merged_into as mergedInto'])
          .where('id', '=', person.userId)
          .executeTakeFirst()
        if (end != null && end.mergedInto == null) {
          res.redirect(
            303,
            `/api/v1/players/${encodeURIComponent(person.userId)}/name`
          )
          return
        }
      }

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
      const userId = userIdParam(req.params.userId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      const limit = limitOf(req.query.limit)
      const before = dateOf(req.query.before)
      // The same season, team and year the page's stats are narrowed to, so
      // the Videos tab and the Stats tab answer one question.
      const filter = playerFilterOf(req.query)

      // Every row that is this person, because a merge closes a row without
      // moving what was written under it.
      const person = await onePerson(db, userId)
      // Their own plays, and their guardian's child's, from every team.
      const ownPlays =
        person.userIds.includes(actor.userId) ||
        (await guardsPerson(db, scopes, actor.userId, person))

      // The plays this person is credited on. The credit is what the row is
      // drawn from, so the credit is what is searched: `event_players` says
      // somebody was named on a play, which is not the same as somebody having
      // done something worth watching.
      const creditsByEvent = await creditsForPlayer(db, person.userId)
      // A team filter is the team they played for, as on their stats: a play
      // whose credit names another team of theirs is that team's, even in a
      // game against this one. A credit with no team leaves it to the game.
      const eventIds = [...creditsByEvent]
        .filter(([, credits]) => {
          if (filter.teamId == null) return true
          const teams = new Set(
            credits
              .filter(
                outcome =>
                  outcome.creditUserId != null &&
                  person.userIds.includes(outcome.creditUserId)
              )
              .map(outcome => outcome.teamId)
          )
          teams.delete(null)
          return teams.size === 0 || teams.has(filter.teamId)
        })
        .map(([eventId]) => eventId)
      if (eventIds.length === 0) {
        res.json({ highlights: [], nextBefore: null, withoutVideo: 0 })
        return
      }

      let query = db
        .selectFrom('events')
        .innerJoin('games', 'games.id', 'events.gameId')
        .select([
          ...HIGHLIGHT_EVENT_COLUMNS,
          'events.gameId as gameId',
          'games.home_team_id as homeTeamId',
          'games.away_team_id as awayTeamId',
          'games.season_id as seasonId',
          'games.ingest_status as ingestStatus'
        ])
        .where('events.id', 'in', eventIds)
        .where('events.hidden', '=', false)
        .where('events.startTime', 'is not', null)
      if (before != null) {
        query = query.where('events.startTime', '<', before)
      }
      // Narrowed before the page is cut, so a filtered page is as full as an
      // unfiltered one and `nextBefore` pages through the filtered plays.
      const { seasonId, teamId, year } = filter
      if (seasonId != null) {
        query = query.where('games.season_id', '=', seasonId)
      }
      if (teamId != null) {
        query = query.where(eb =>
          eb.or([
            eb('games.home_team_id', '=', teamId),
            eb('games.away_team_id', '=', teamId)
          ])
        )
      }
      if (year != null) {
        query = query
          .where('games.start_at', '>=', new Date(Date.UTC(year, 0, 1)))
          .where('games.start_at', '<', new Date(Date.UTC(year + 1, 0, 1)))
      }

      const rows = await query
        .orderBy('events.startTime', 'desc')
        // One extra, so the page knows whether there is another without
        // counting every play this child has ever been part of.
        .limit(limit + 1)
        .execute()

      const seen = rows.filter(
        row =>
          scopes.isAdmin ||
          ownPlays ||
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
        title: string
        tag: string | null
        playAt: string
        startOffsetSec: number
        playOffsetSec: number
        stillUrl: string
        storage: 'peertube' | 'local' | 'spaces'
      }
      const now = Date.now()
      const out: Row[] = []

      for (const row of usable) {
        const credits = creditsByEvent.get(row.id) ?? []
        // The play's credits for this person, by any of their rows.
        const mine = credits.filter(
          outcome =>
            outcome.creditUserId != null &&
            person.userIds.includes(outcome.creditUserId)
        )
        if (mine.length === 0) continue

        // The video that was running when the play happened. The program
        // recording first, which is the one a game is normally watched on.
        for (const video of videos.filter(item => item.gameId === row.gameId)) {
          const computed = withDropped(
            [highlightEvent(row, credits)],
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
            eventId: row.id,
            gameId: row.gameId,
            videoId: video.id,
            teamId,
            teamName: teamId == null ? null : (names.get(teamId) ?? null),
            outcome: outcomeName(outcome),
            title: highlight.title,
            tag: highlight.tag ?? null,
            playAt: highlight.playAt.toISOString(),
            startOffsetSec: highlight.startOffsetSec,
            playOffsetSec: highlight.playOffsetSec,
            stillUrl: stillUrl(media, video.id, highlight.playOffsetSec, now),
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

  /**
   * What a roster manager sets for one player on one team: the jersey and
   * positions belong to this team; the name and how they bat and throw belong
   * to the player and read the same on every team.
   *
   * A coach, assistant or scorekeeper of the team (set on it, or on its
   * season or league), an administrator of any of those, a guardian of the
   * player, and a site administrator (`mayManagePlayer`). Anybody else, and
   * anybody who is not a player on this team, is answered 404: the question
   * "may I change this?" is not asked of a page nobody offered. Preserve
   * canManageRoster's intentional scorekeeper exception: they may be the only
   * person responsible for maintaining the roster.
   *
   * Setting either hand marks it `manual`, so the next roster import
   * leaves the roster manager's answer alone. The answer is the player's roster
   * entry as it now reads, the same shape `GET /teams/:teamId/roster` lists.
   */
  router.put(
    '/teams/:teamId/players/:userId/settings',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const userId = userIdParam(req.params.userId)
      if (!(await mayManagePlayer(db, actor, userId, teamId))) throw notFound()

      const place = await db
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select([
          'memberships.id as membershipId',
          'memberships.jersey as jersey',
          'memberships.positions as positions',
          'users.bats as bats',
          'users.throws as throws',
          'users.first_name as firstName',
          'users.last_name as lastName',
          'users.display_name as displayName'
        ])
        .where('memberships.team_id', '=', teamId)
        .where('memberships.user_id', '=', userId)
        .where('memberships.is_player', '=', true)
        .where('users.merged_into', 'is', null)
        .executeTakeFirst()
      if (place == null) throw notFound()

      const body = cleanBody(asPlayerSettings, req.body)
      if (
        body.name !== undefined &&
        !(await mayEditName(db, actor.userId, userId, {
          isAdmin: actor.isAdmin
        }))
      ) {
        throw notFound()
      }

      await db.transaction().execute(async trx => {
        if (body.jersey !== undefined || body.positions !== undefined) {
          await trx
            .updateTable('memberships')
            .set({
              ...(body.jersey === undefined ? {} : { jersey: body.jersey }),
              ...(body.positions === undefined
                ? {}
                : { positions: body.positions })
            })
            .where('id', '=', place.membershipId)
            .execute()
        }
        if (
          body.bats !== undefined ||
          body.throws !== undefined ||
          body.name !== undefined
        ) {
          await trx
            .updateTable('users')
            .set({
              ...(body.bats === undefined ? {} : { bats: body.bats }),
              ...(body.throws === undefined ? {} : { throws: body.throws }),
              ...(body.bats === undefined && body.throws === undefined
                ? {}
                : { bats_source: 'manual' }),
              ...(body.name === undefined
                ? {}
                : {
                    first_name:
                      body.name.firstName === '' ? null : body.name.firstName,
                    last_name:
                      body.name.lastName === '' ? null : body.name.lastName,
                    display_name: [body.name.firstName, body.name.lastName]
                      .filter(Boolean)
                      .join(' ')
                  }),
              updated_at: new Date()
            })
            .where('id', '=', userId)
            .execute()
        }
      })

      const before = {
        teamId,
        ...(body.name === undefined
          ? {}
          : {
              name: { firstName: place.firstName, lastName: place.lastName },
              displayName: place.displayName
            }),
        jersey: place.jersey,
        positions: place.positions,
        bats: place.bats,
        throws: place.throws
      }
      setAudit(res.locals, {
        entityType: 'playerSettings',
        entityId: userId,
        before,
        after: {
          ...before,
          ...body,
          ...(body.name === undefined
            ? {}
            : {
                displayName: [body.name.firstName, body.name.lastName]
                  .filter(Boolean)
                  .join(' ')
              })
        }
      })

      const roster = await teamRoster(db, media.space, teamId, true)
      const entry = roster.find(row => row.userId === userId)
      if (entry == null) throw notFound()
      res.json(entry)
    })
  )

  /**
   * How a player bats and throws, which is theirs on every team, asked about
   * the person rather than their place on one team: what a guardian sets
   * from Home.
   *
   * A guardian of the player, a coach, assistant or scorekeeper of any team
   * they play on, or its administrator, and a site administrator
   * (`mayManagePlayer` without a team). Anybody else,
   * and a row closed into another, is answered 404. `jersey` and `positions`
   * belong to a team and are refused here with 400, as is a body that changes
   * nothing. Setting either hand marks it `manual`, as the team's settings
   * do, and is audited the same way.
   */
  router.put(
    '/players/:userId/settings',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const userId = userIdParam(req.params.userId)
      if (!(await mayManagePlayer(db, actor, userId, null))) throw notFound()

      const user = await db
        .selectFrom('users')
        .select(['bats', 'throws'])
        .where('id', '=', userId)
        .where('merged_into', 'is', null)
        .executeTakeFirst()
      if (user == null) throw notFound()

      const body = cleanBody(asPersonSettings, req.body)
      const after = await db
        .updateTable('users')
        .set({
          ...(body.bats === undefined ? {} : { bats: body.bats }),
          ...(body.throws === undefined ? {} : { throws: body.throws }),
          bats_source: 'manual',
          updated_at: new Date()
        })
        .where('id', '=', userId)
        .returning(['bats', 'throws'])
        .executeTakeFirstOrThrow()

      setAudit(res.locals, {
        entityType: 'playerSettings',
        entityId: userId,
        before: { bats: user.bats, throws: user.throws },
        after: { bats: after.bats, throws: after.throws }
      })
      res.json({ userId, bats: after.bats, throws: after.throws })
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
  /** The team's logo in the Space, which a page signs into `logoUrl`. */
  logoPath: string | null
  seasonId: string | null
  seasonName: string | null
  seasonYear: number | null
  /** Their number on this team; null on a team they only have stats for. */
  jersey: string | null
  /** Where they play on this team; empty on a team they only have stats for. */
  positions: string[]
  /**
   * Whether they play on this team now: a player's membership of it, on any
   * of their rows. False on a team they only have stats for, such as one they
   * have left. Read by `teamsPlayedOnNow`, the test `mayManagePlayer` makes
   * of a team.
   */
  current: boolean
}

/**
 * Every team this person has played for, and in which season.
 *
 * Two sources, because neither is complete on its own: a membership is a team
 * they were put on, and a stats row is a team they actually batted for. A
 * child imported from a roster has the first without the second until their
 * games are ingested; a child who appears only in an opponent's play-by-play
 * can have the second without the first.
 *
 * A team appears once for each season it is in, belongs to or played in, and
 * without a season only when it has none. Each row carries the jersey and positions of
 * their membership on that team, which a stats row has no way to know, and
 * whether they play there now.
 */
export async function teamsOf(
  db: Kysely<Database>,
  userIds: number[]
): Promise<PlayerTeam[]> {
  // Every row that is this person: a child on five teams was five imports,
  // and the teams of the four that were closed are still theirs.
  if (userIds.length === 0) return []
  // A team's seasons: those it competes in, and those it belongs to.
  const teamSeasons = db
    .selectFrom('season_teams')
    .select(['season_id', 'team_id'])
    .union(
      db.selectFrom('season_team_parents').select(['season_id', 'team_id'])
    )
    .as('team_seasons')
  const fromMemberships = await db
    .selectFrom('memberships')
    .innerJoin('teams', 'teams.id', 'memberships.team_id')
    .leftJoin(teamSeasons, 'team_seasons.team_id', 'memberships.team_id')
    .leftJoin('seasons', 'seasons.id', 'team_seasons.season_id')
    .select([
      'memberships.team_id as teamId',
      'memberships.user_id as userId',
      'memberships.jersey as jersey',
      'memberships.positions as positions',
      'teams.name as teamName',
      'teams.logo_path as logoPath',
      'seasons.id as seasonId',
      'seasons.name as seasonName',
      'seasons.year as seasonYear'
    ])
    .where('memberships.user_id', 'in', userIds)
    .where('memberships.is_player', '=', true)
    .where('teams.merged_into', 'is', null)
    .execute()

  // The stat lines themselves, which the stats builder rewrites whenever a
  // game's plays change, so a team they batted for yesterday is here today.
  const fromPlays = await db
    .selectFrom('game_player_stats')
    .innerJoin('games', 'games.id', 'game_player_stats.game_id')
    .innerJoin('teams', 'teams.id', 'game_player_stats.team_id')
    .leftJoin('seasons', 'seasons.id', 'games.season_id')
    .select([
      'teams.id as teamId',
      'teams.name as teamName',
      'teams.logo_path as logoPath',
      'seasons.id as seasonId',
      'seasons.name as seasonName',
      'seasons.year as seasonYear'
    ])
    .distinct()
    .where('game_player_stats.user_id', 'in', userIds)
    .where('teams.merged_into', 'is', null)
    .execute()

  // Their place on each team. One person can be on a team under two rows
  // until a merge tidies it up; the open row (first in `userIds`) speaks
  // first, and a closed row fills in only what the open one left blank.
  const places = new Map<
    string,
    { jersey: string | null; positions: string[] }
  >()
  const byRow = [...fromMemberships].sort(
    (a, b) => userIds.indexOf(a.userId) - userIds.indexOf(b.userId)
  )
  for (const row of byRow) {
    const place = places.get(row.teamId) ?? { jersey: null, positions: [] }
    places.set(row.teamId, {
      jersey: place.jersey ?? row.jersey,
      positions: place.positions.length > 0 ? place.positions : row.positions
    })
  }

  const playing = new Set(await teamsPlayedOnNow(db, userIds))
  const byKey = new Map<string, PlayerTeam>()
  for (const row of [...fromPlays, ...fromMemberships]) {
    const place = places.get(row.teamId)
    byKey.set(`${row.teamId} ${row.seasonId ?? ''}`, {
      teamId: row.teamId,
      teamName: row.teamName,
      logoPath: row.logoPath,
      seasonId: row.seasonId,
      seasonName: row.seasonName,
      seasonYear: row.seasonYear,
      jersey: place?.jersey ?? null,
      positions: place?.positions ?? [],
      current: playing.has(row.teamId)
    })
  }

  // A team listed in a season needs no second row without one: its games
  // outside any season are still its games.
  const seasoned = new Set(
    [...byKey.values()]
      .filter(team => team.seasonId != null)
      .map(team => team.teamId)
  )
  for (const team of seasoned) byKey.delete(`${team} `)

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

function userIdParam(value: string | string[] | undefined): number {
  try {
    return asUserId(pathParam(value))
  } catch {
    throw notFound()
  }
}
