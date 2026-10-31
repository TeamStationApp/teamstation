import { Router } from 'express'
import type { Kysely } from 'kysely'

import { forbidden, notFound, unauthorized } from '../../common/errors'
import { asTeamAdultsBody, asTeamPlayersBody } from '../../common/teamMembers'
import { asUserId } from '../../common/userId'
import {
  adminScopes,
  canManageTeam,
  canSeeTeam,
  heldByOpenAdd,
  mayEditName,
  visibleScopes
} from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { addAdults } from '../teams/addAdults'
import { addPlayers } from '../teams/addPlayers'
import {
  asPictureBody,
  storePlayerAvatar,
  storeTeamLogo
} from '../teams/storeTeamPictures'
import { refuseDeleted } from '../users/deleted'

/**
 * A team's people, added by the ids another system knows them by, and the
 * team's logo and its players' headshots.
 *
 * Only an administrator of the team may call these: one set on the team, on
 * its season or on its league, its owner or manager, or a site
 * administrator. A team the caller can neither see nor administer answers
 * 404, so probing cannot reveal that it exists; one they can see but not
 * administer, 403. Somebody another system's id already names is added to
 * the team wherever else they are, as adding a person by address is.
 */
export function teamMemberRoutes(
  db: Kysely<Database>,
  media: Pick<MediaContext, 'ffmpegPath' | 'space'>
): Router {
  const router = Router()

  /** 404 or 403 unless the caller may manage the team. */
  const mustManage = async (actor: Actor, teamId: string): Promise<void> => {
    const team = await db
      .selectFrom('teams')
      .select(['id'])
      .where('id', '=', teamId)
      .executeTakeFirst()
    if (team == null) throw notFound()
    const admin = await adminScopes(db, actor.userId, actor.isAdmin)
    if (canManageTeam(admin, teamId)) return
    const seen = await visibleScopes(db, actor.userId, actor.isAdmin)
    if (!canSeeTeam(seen, teamId)) throw notFound()
    throw forbidden(
      'Only an administrator of this team may change its people and pictures'
    )
  }

  /**
   * Players, by external id: the user holding the id, or a new one who
   * cannot sign in, made a player of the team.
   */
  router.post(
    '/teams/:teamId/players',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      await mustManage(actor, teamId)
      const body = cleanBody(asTeamPlayersBody, req.body)

      const answer = await addPlayers(db, teamId, body.players)
      setAudit(res.locals, {
        entityType: 'team',
        entityId: teamId,
        after: { players: answer.counts }
      })
      res.json(answer)
    })
  )

  /**
   * Parents, followers and staff, by external id or address: made users
   * where nobody holds either, with sign-in by e-mail code where there is an
   * address, and nobody mailed. Players come first, so guardian links find
   * them.
   */
  router.post(
    '/teams/:teamId/adults',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      await mustManage(actor, teamId)
      const body = cleanBody(asTeamAdultsBody, req.body)

      const answer = await addAdults(db, teamId, body.adults, actor)
      setAudit(res.locals, {
        entityType: 'team',
        entityId: teamId,
        after: { adults: answer.counts }
      })
      res.json(answer)
    })
  )

  /** The team's logo, from JPEG, PNG or WebP bytes sent as base64. */
  router.put(
    '/teams/:teamId/logo',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      await mustManage(actor, teamId)
      const picture = asPictureBody(req.body)

      const answer = await storeTeamLogo(db, media, teamId, picture)
      setAudit(res.locals, {
        entityType: 'team',
        entityId: teamId,
        after: { logo: { stored: answer.stored, source: picture.source } }
      })
      res.json(answer)
    })
  )

  /**
   * A player's headshot, for a user who plays for this team. It is their
   * own picture, so it shows on every team they are on.
   */
  router.put(
    '/teams/:teamId/players/:userId/avatar',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      await mustManage(actor, teamId)
      let userId: string
      try {
        userId = asUserId(pathParam(req.params.userId))
      } catch {
        throw notFound()
      }
      const plays = await db
        .selectFrom('memberships')
        .select(['id'])
        .where('team_id', '=', teamId)
        .where('user_id', '=', userId)
        .where('is_player', '=', true)
        .executeTakeFirst()
      if (plays == null) throw notFound('No such player on this team')
      await refuseDeleted(db, userId)
      if (
        (await heldByOpenAdd(db, teamId, [userId])) &&
        !(await mayEditName(db, actor.userId, userId, actor))
      )
        throw forbidden(
          'Their picture is their own while their side may reject this add'
        )
      const picture = asPictureBody(req.body)

      const answer = await storePlayerAvatar(
        db,
        media,
        userId,
        picture,
        actor.isAdmin
      )
      setAudit(res.locals, {
        entityType: 'user',
        entityId: userId,
        after: {
          avatar: { stored: answer.stored, source: picture.source, teamId }
        }
      })
      res.json(answer)
    })
  )

  return router
}

/** A path segment, or 404 for one Express could not give as one string. */
function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
