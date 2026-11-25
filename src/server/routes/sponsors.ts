import { asNumber, asObject, asOptional, asString, asValue } from 'cleaners'
import express, { type Request, type RequestHandler, Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, notFound, unauthorized } from '../../common/errors'
import { maxBytesFor, sizeProblem } from '../../common/sponsors/limits'
import {
  SPONSOR_MEDIA_PURPOSES,
  type SponsorMediaPurpose
} from '../../common/sponsors/types'
import { canSeeGame, visibleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { requireGroupAdmin } from '../groups/rights'
import { cleanBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { MEDIA_TOKEN_TTL_SEC } from '../media/mediaTokens'
import type { PlaybackDeps } from '../media/playbackAnswer'
import { SpacePlayback } from '../media/spacesHls'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import {
  addCreditRow,
  type CreditKind,
  creditRowLeague,
  deactivateCreditRow,
  setCreditAllocation,
  sponsorState
} from '../sponsors/credits'
import { gameSponsorsFor } from '../sponsors/logos'
import { storeSponsorMedia } from '../sponsors/media'
import {
  addSponsorRow,
  deleteSponsorRow,
  editSponsorRow,
  sponsorRowLeague
} from '../sponsors/rows'
import { sampleVideoFor } from '../sponsors/sample'

export interface SponsorRouteOptions {
  /** A reel waits under `<uploadsDir>/sponsors/` while it is probed. */
  uploadsDir: string
  /** The clock for placing rows and their 24 hours; the real one by default. */
  clock?: () => Date
}

const asTextColor = asValue('dark', 'white')

const asNewCreditRow = asObject({
  mediaId: asString,
  name: asString,
  allocation: asNumber
})

const asAllocation = asObject({ allocation: asNumber })

const asNewRow = asObject({
  logoMediaId: asString,
  backgroundMediaId: asString,
  title: asString,
  message: asString,
  url: asString,
  textColor: asOptional(asTextColor, 'dark'),
  startsAt: asString
})

const asRowPatch = asObject({
  logoMediaId: asOptional(asString),
  backgroundMediaId: asOptional(asString),
  title: asOptional(asString),
  message: asOptional(asString),
  url: asOptional(asString),
  textColor: asOptional(asTextColor),
  startsAt: asOptional(asString)
})

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

function actorOf(req: Request): Actor {
  if (req.actor == null) throw unauthorized()
  return req.actor
}

function purposeOf(raw: unknown): SponsorMediaPurpose {
  const purpose = SPONSOR_MEDIA_PURPOSES.find(each => each === raw)
  if (purpose == null)
    throw badRequest(
      `purpose must be one of ${SPONSOR_MEDIA_PURPOSES.join(', ')}`
    )
  return purpose
}

/**
 * A league's sponsor features, for its administrators: what it holds, its
 * uploads, its logos and reels with their credits, its sponsored rows, and
 * the video the previews play. Every route needs an administrator of the
 * league (404 for a league that is not there), and every change answers the
 * league's whole `SponsorState`.
 *
 * - `GET /leagues/:leagueId/sponsors`
 * - `POST /leagues/:leagueId/sponsors/media?purpose=logo|reel|rowLogo|rowBackground`,
 *   the file's raw bytes → 201 `{ mediaId, url, width, height, durationMs }`.
 *   Checked, never changed: a file that does not fit is a 400 with the
 *   screen's sentence.
 * - `POST /leagues/:leagueId/sponsors/logos` `{ mediaId, name, allocation }`
 *   → 201; `PATCH /sponsors/logos/:logoId` `{ allocation }`;
 *   `POST /sponsors/logos/:logoId/deactivate`. The same for `reels`.
 * - `POST /leagues/:leagueId/sponsors/rows` `{ logoMediaId,
 *   backgroundMediaId, title, message, url, textColor, startsAt }` → 201;
 *   `PATCH /sponsors/rows/:rowId` with any of them, within 24 hours of
 *   placing; `DELETE /sponsors/rows/:rowId`.
 * - `GET /leagues/:leagueId/sponsors/sample` → `SampleVideo`.
 *
 * And for anybody who may watch a game's video (the same access as
 * `GET /videos/:videoId/playback`; 404 otherwise):
 *
 * - `GET /games/:gameId/sponsors` → `GameSponsors`, the logo and reels its
 *   players draw.
 */
export function sponsorRoutes(
  db: Kysely<Database>,
  media: MediaContext,
  options: SponsorRouteOptions
): Router {
  const router = Router()
  const clock = options.clock ?? (() => new Date())
  const playback: PlaybackDeps = {
    mediaRoot: media.mediaRoot,
    space: media.space,
    playlists: new SpacePlayback({
      space: media.space,
      expiresSec: MEDIA_TOKEN_TTL_SEC
    }).playlists,
    publicUrl: media.publicUrl,
    mediaSecret: media.mediaSecret
  }
  const admin = async (req: Request, leagueId: string): Promise<void> => {
    await requireGroupAdmin(db, actorOf(req), { kind: 'league', id: leagueId })
  }
  const state = async (leagueId: string): Promise<unknown> =>
    await sponsorState(db, media.space, leagueId)

  router.get(
    '/leagues/:leagueId/sponsors',
    requireActor,
    withAsync(async (req, res) => {
      const leagueId = pathParam(req.params.leagueId)
      await admin(req, leagueId)
      res.json(await state(leagueId))
    })
  )

  /**
   * The body is read only once the caller is known to administer the
   * league, and only up to the purpose's cap and a byte: a byte over is
   * refused with the sentence, more is never read.
   */
  const mediaBody: RequestHandler = (req, res, next) => {
    let purpose: SponsorMediaPurpose
    try {
      purpose = purposeOf(req.query.purpose)
    } catch (error) {
      next(error)
      return
    }
    const cap = maxBytesFor(purpose) + 1
    express.raw({ type: () => true, limit: cap })(req, res, error => {
      if ((error as { type?: string } | undefined)?.type === 'entity.too.large')
        next(badRequest(sizeProblem(purpose, cap) ?? 'That file is too large'))
      else next(error)
    })
  }

  router.post(
    '/leagues/:leagueId/sponsors/media',
    requireActor,
    withAsync(async (req, _res, next) => {
      purposeOf(req.query.purpose)
      await admin(req, pathParam(req.params.leagueId))
      next()
    }),
    mediaBody,
    withAsync(async (req, res) => {
      const leagueId = pathParam(req.params.leagueId)
      const bytes: unknown = req.body
      if (!Buffer.isBuffer(bytes) || bytes.length === 0)
        throw badRequest('Choose a file to upload.')
      const stored = await storeSponsorMedia(
        {
          db,
          space: media.space,
          ffmpegPath: media.ffmpegPath,
          uploadsDir: options.uploadsDir
        },
        {
          leagueId,
          purpose: purposeOf(req.query.purpose),
          bytes,
          userId: actorOf(req).userId
        }
      )
      setAudit(res.locals, {
        entityType: 'sponsorMedia',
        entityId: stored.mediaId
      })
      res.status(201).json(stored)
    })
  )

  const creditRoutes = (kind: CreditKind, plural: 'logos' | 'reels'): void => {
    const param = kind === 'logo' ? 'logoId' : 'reelId'
    const entityType = kind === 'logo' ? 'sponsorLogo' : 'sponsorReel'
    router.post(
      `/leagues/:leagueId/sponsors/${plural}`,
      requireActor,
      withAsync(async (req, res) => {
        const leagueId = pathParam(req.params.leagueId)
        await admin(req, leagueId)
        const body = cleanBody(asNewCreditRow, req.body)
        const id = await addCreditRow(db, kind, leagueId, body, clock())
        setAudit(res.locals, { entityType, entityId: id })
        res.status(201).json(await state(leagueId))
      })
    )
    router.patch(
      `/sponsors/${plural}/:${param}`,
      requireActor,
      withAsync(async (req, res) => {
        const id = pathParam(req.params[param])
        const leagueId = await creditRowLeague(db, kind, id)
        await admin(req, leagueId)
        const { allocation } = cleanBody(asAllocation, req.body)
        await setCreditAllocation(db, kind, leagueId, id, allocation)
        setAudit(res.locals, { entityType, entityId: id })
        res.json(await state(leagueId))
      })
    )
    router.post(
      `/sponsors/${plural}/:${param}/deactivate`,
      requireActor,
      withAsync(async (req, res) => {
        const id = pathParam(req.params[param])
        const leagueId = await creditRowLeague(db, kind, id)
        await admin(req, leagueId)
        await deactivateCreditRow(db, kind, leagueId, id, clock())
        setAudit(res.locals, { entityType, entityId: id })
        res.json(await state(leagueId))
      })
    )
  }
  creditRoutes('logo', 'logos')
  creditRoutes('reel', 'reels')

  router.post(
    '/leagues/:leagueId/sponsors/rows',
    requireActor,
    withAsync(async (req, res) => {
      const leagueId = pathParam(req.params.leagueId)
      await admin(req, leagueId)
      const rowId = await addSponsorRow(
        db,
        leagueId,
        cleanBody(asNewRow, req.body),
        clock()
      )
      setAudit(res.locals, { entityType: 'sponsorRow', entityId: rowId })
      res.status(201).json(await state(leagueId))
    })
  )
  router.patch(
    '/sponsors/rows/:rowId',
    requireActor,
    withAsync(async (req, res) => {
      const rowId = pathParam(req.params.rowId)
      const leagueId = await sponsorRowLeague(db, rowId)
      await admin(req, leagueId)
      await editSponsorRow(
        db,
        leagueId,
        rowId,
        cleanBody(asRowPatch, req.body),
        clock()
      )
      setAudit(res.locals, { entityType: 'sponsorRow', entityId: rowId })
      res.json(await state(leagueId))
    })
  )
  router.delete(
    '/sponsors/rows/:rowId',
    requireActor,
    withAsync(async (req, res) => {
      const rowId = pathParam(req.params.rowId)
      const leagueId = await sponsorRowLeague(db, rowId)
      await admin(req, leagueId)
      await deleteSponsorRow(db, leagueId, rowId, clock())
      setAudit(res.locals, { entityType: 'sponsorRow', entityId: rowId })
      res.json(await state(leagueId))
    })
  )

  router.get(
    '/leagues/:leagueId/sponsors/sample',
    requireActor,
    withAsync(async (req, res) => {
      const leagueId = pathParam(req.params.leagueId)
      await admin(req, leagueId)
      res.json(
        await sampleVideoFor(
          db,
          playback,
          leagueId,
          undefined,
          clock().getTime()
        )
      )
    })
  )

  router.get(
    '/games/:gameId/sponsors',
    requireActor,
    withAsync(async (req, res) => {
      const actor = actorOf(req)
      const gameId = pathParam(req.params.gameId)
      const game = await db
        .selectFrom('games')
        .select([
          'home_team_id as homeTeamId',
          'away_team_id as awayTeamId',
          'season_id as seasonId'
        ])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (
        game == null ||
        !canSeeGame(await visibleScopes(db, actor.userId, actor.isAdmin), game)
      )
        throw notFound()
      res.json(await gameSponsorsFor(db, media.space, gameId))
    })
  )

  return router
}
