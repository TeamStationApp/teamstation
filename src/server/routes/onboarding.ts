import { Router } from 'express'
import type { Kysely } from 'kysely'

import { asAccountName } from '../../common/accountSettings'
import { badRequest, conflict, unauthorized } from '../../common/errors'
import { onboardingFor } from '../auth/settleAccount'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { selectAccountCatalogPicture } from '../media/pictureCatalog'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import type { PictureStore } from '../teams/storeTeamPictures'
import { asPictureBody, storePlayerAvatar } from '../teams/storeTeamPictures'

export function onboardingRoutes(
  db: Kysely<Database>,
  store: PictureStore
): Router {
  const router = Router()
  router.use('/me/onboarding', requireActor)
  router.get(
    '/me/onboarding',
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null || actor.apiTokenId != null) throw unauthorized()
      const user = await db
        .selectFrom('users')
        .select('display_name')
        .where('id', '=', actor.userId)
        .executeTakeFirstOrThrow()
      res.json({
        displayName: user.display_name,
        onboarding: await onboardingFor(db, actor.userId)
      })
    })
  )
  router.put(
    '/me/onboarding/name',
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null || actor.apiTokenId != null) throw unauthorized()
      let name: string
      try {
        name = asAccountName(req.body?.displayName)
      } catch {
        throw badRequest('Enter a name between 1 and 120 characters')
      }
      await db.transaction().execute(async trx => {
        await lockKeys(trx, [`account:${actor.userId}`])
        const user = await trx
          .selectFrom('users')
          .select('onboarding_step')
          .where('id', '=', actor.userId)
          .forUpdate()
          .executeTakeFirstOrThrow()
        if (user.onboarding_step === 'complete')
          throw conflict(
            'Onboarding is already complete. Edit your name in Account.'
          )
        const [first, ...rest] = name.split(' ')
        await trx
          .updateTable('users')
          .set({
            display_name: name,
            first_name: first,
            last_name: rest.length === 0 ? null : rest.join(' '),
            onboarding_step: 'photo',
            updated_at: new Date()
          })
          .where('id', '=', actor.userId)
          .execute()
      })
      res.json({
        displayName: name,
        onboarding: await onboardingFor(db, actor.userId)
      })
    })
  )
  router.put(
    '/me/onboarding/photo',
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null || actor.apiTokenId != null) throw unauthorized()
      const body = req.body ?? {}
      const choices = [
        body.catalogId != null,
        body.image != null,
        body.initials === true
      ].filter(Boolean).length
      if (choices !== 1) throw badRequest('Choose one picture or use initials')
      await db.transaction().execute(async trx => {
        await lockKeys(trx, [`account:${actor.userId}`])
        const user = await trx
          .selectFrom('users')
          .select('onboarding_step')
          .where('id', '=', actor.userId)
          .forUpdate()
          .executeTakeFirstOrThrow()
        if (user.onboarding_step === 'complete') return
        if (user.onboarding_step !== 'photo')
          throw conflict('Save your name first')
        if (body.catalogId != null) {
          try {
            await selectAccountCatalogPicture(trx, actor.userId, body.catalogId)
          } catch (error) {
            if (error instanceof TypeError) throw badRequest(error.message)
            throw error
          }
        } else if (body.image != null)
          await storePlayerAvatar(
            trx,
            store,
            actor.userId,
            asPictureBody({ image: body.image, source: 'upload' }),
            true
          )
        else
          await trx
            .updateTable('users')
            .set({
              picture_catalog_id: null,
              avatar_path: null,
              avatar_sha256: null,
              avatar_source: null
            })
            .where('id', '=', actor.userId)
            .execute()
        await trx
          .updateTable('users')
          .set({
            onboarding_step: 'complete',
            onboarding_completed_at: new Date()
          })
          .where('id', '=', actor.userId)
          .execute()
      })
      res.json({ ok: true })
    })
  )
  return router
}
