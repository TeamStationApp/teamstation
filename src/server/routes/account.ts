import { type Request, Router } from 'express'
import type { Kysely } from 'kysely'

import {
  type AccountSettings,
  asAccountEmailConfirmation,
  asAccountEmailRequest,
  asAccountNameBody,
  asAccountPasswordBody,
  asAccountPrimaryBody
} from '../../common/accountSettings'
import {
  badRequest,
  conflict,
  forbidden,
  unauthorized,
  unavailable
} from '../../common/errors'
import {
  confirmAccountEmail,
  requestAccountEmail,
  selectPrimaryEmail
} from '../account/emails'
import {
  confirmPasswordReset,
  requestPasswordReset
} from '../account/passwordReset'
import {
  createPasswordRecord,
  passwordMatches,
  passwordSalt,
  readPasswordRecord
} from '../auth/passwords'
import { checkLimits, type LimitRule, recordAttempts } from '../auth/rateLimit'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import { imageUrl, PROFILE_SIZE } from '../media/imageUrls'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import {
  asPictureBody,
  type PictureStore,
  storePlayerAvatar
} from '../teams/storeTeamPictures'

export interface AccountOptions extends PictureStore {
  sendCode: (email: string, code: string) => Promise<void>
}

export async function readAccount(
  db: Kysely<Database>,
  userId: number,
  options: PictureStore
): Promise<AccountSettings> {
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .where('merged_into', 'is', null)
    .where('login_enabled', '=', true)
    .executeTakeFirst()
  if (user == null) throw unauthorized()
  const emails = await db
    .selectFrom('user_emails')
    .select(['id', 'email', 'is_primary as isPrimary'])
    .where('user_id', '=', userId)
    .orderBy('is_primary', 'desc')
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return {
    user: {
      id: user.id,
      displayName: user.display_name,
      isAdmin: user.is_admin,
      email: emails[0]?.email,
      avatarUrl: imageUrl(options.space, user.avatar_path, PROFILE_SIZE)
    },
    hasPassword: user.password_hash != null && user.password_hash !== '',
    passwordNeedsUpgrade:
      user.password_hash != null &&
      user.password_hash !== '' &&
      readPasswordRecord(user.password_hash) == null,
    passwordParameters: (() => {
      const record = readPasswordRecord(user.password_hash)
      return record == null
        ? null
        : { client: record.client, server: record.server }
    })(),
    newPasswordSalt: passwordSalt(),
    emails
  }
}

/** Protect each short authorization/write phase; never hold this lock during hashing. */
async function lockAccount(
  db: Kysely<Database>,
  userId: number
): Promise<string | null> {
  const user = await db
    .selectFrom('users')
    .select('password_hash')
    .where('id', '=', userId)
    .where('merged_into', 'is', null)
    .where('login_enabled', '=', true)
    .forUpdate()
    .executeTakeFirst()
  if (user == null) throw unauthorized()
  return user.password_hash
}

function accountId(req: Request): number {
  if (req.actor == null) throw unauthorized()
  if (req.actor.apiTokenId != null)
    throw forbidden('Sign in to manage your account')
  return req.actor.userId
}

async function limit(
  db: Kysely<Database>,
  userId: number,
  action: string,
  maximum: number,
  email?: string
): Promise<void> {
  const rules: LimitRule[] = [
    {
      scope: `account.${action}`,
      key: String(userId),
      limit: maximum,
      windowSec: 900
    }
  ]
  if (email != null)
    rules.push({
      scope: 'account.emailAddress',
      key: email,
      limit: 5,
      windowSec: 900
    })
  await checkLimits(db, rules)
  await recordAttempts(db, rules)
}

/** These endpoints are for a signed-in person, never a machine acting for them. */
export function accountRoutes(
  db: Kysely<Database>,
  options: AccountOptions
): Router {
  const router = Router()
  router.use('/me/account', requireActor)
  router.get(
    '/me/account',
    withAsync(async (req, res) => {
      res.json(await readAccount(db, accountId(req), options))
    })
  )
  router.put(
    '/me/account/name',
    withAsync(async (req, res) => {
      const userId = accountId(req)
      const { displayName } = cleanBody(asAccountNameBody, req.body)
      const [first, ...rest] = displayName.split(' ')
      await db.transaction().execute(async tx => {
        await lockAccount(tx, userId)
        await tx
          .updateTable('users')
          .set({
            display_name: displayName,
            first_name: first,
            last_name: rest.length === 0 ? null : rest.join(' '),
            updated_at: new Date()
          })
          .where('id', '=', userId)
          .execute()
      })
      setAudit(res.locals, { entityType: 'user', entityId: userId })
      res.json(await readAccount(db, userId, options))
    })
  )
  router.put(
    '/me/account/photo',
    withAsync(async (req, res) => {
      const userId = accountId(req)
      const picture = asPictureBody({
        image: req.body?.image,
        source: 'upload'
      })
      await db.transaction().execute(async tx => {
        await lockAccount(tx, userId)
        // The signed-in person may replace their own photo, like a site admin.
        await storePlayerAvatar(tx, options, userId, picture, true)
        await tx
          .updateTable('users')
          .set({ picture_catalog_id: null })
          .where('id', '=', userId)
          .execute()
      })
      setAudit(res.locals, { entityType: 'user', entityId: userId })
      res.json(await readAccount(db, userId, options))
    })
  )
  router.delete(
    '/me/account/photo',
    withAsync(async (req, res) => {
      const userId = accountId(req)
      await db.transaction().execute(async tx => {
        await lockAccount(tx, userId)
        await tx
          .updateTable('users')
          .set({
            picture_catalog_id: null,
            avatar_path: null,
            avatar_sha256: null,
            avatar_source: null,
            avatar_updated_at: new Date(),
            updated_at: new Date()
          })
          .where('id', '=', userId)
          .execute()
      })
      setAudit(res.locals, { entityType: 'user', entityId: userId })
      res.json(await readAccount(db, userId, options))
    })
  )
  router.put(
    '/me/account/password',
    withAsync(async (req, res) => {
      const userId = accountId(req)
      const body = cleanBody(asAccountPasswordBody, req.body)
      const invalidAuthorization = (): Error =>
        badRequest(
          body.reset == null
            ? 'Your current password is incorrect. You can reset it with an email code'
            : 'That code is incorrect or expired. Request a new code'
        )
      const authorization = await db.transaction().execute(async tx => {
        const held = await lockAccount(tx, userId)
        await limit(tx, userId, 'password', 10)
        const allowed =
          body.reset == null ||
          (await confirmPasswordReset(tx, userId, held, body.reset, false))
        return { held, allowed }
      })
      if (!authorization.allowed) throw invalidAuthorization()
      const { held } = authorization
      if (
        body.reset == null &&
        held != null &&
        held !== '' &&
        (readPasswordRecord(held) == null ||
          body.currentClientHash == null ||
          !(await passwordMatches(body.currentClientHash, held, userId)))
      )
        throw invalidAuthorization()
      // Native work owns no database connection or row lock. The final phase
      // compares the exact credential and rechecks/consumes reset authorization.
      const replacement = await createPasswordRecord(
        body.clientHash,
        body.clientParameters,
        userId
      )
      const changed = await db.transaction().execute(async tx => {
        if ((await lockAccount(tx, userId)) !== held)
          throw badRequest('Your password changed. Please try again')
        if (
          body.reset != null &&
          !(await confirmPasswordReset(tx, userId, held, body.reset))
        )
          return false
        await tx
          .updateTable('users')
          .set({
            password_hash: replacement,
            updated_at: new Date()
          })
          .where('id', '=', userId)
          .execute()
        return true
      })
      if (!changed) throw invalidAuthorization()
      setAudit(res.locals, { entityType: 'user', entityId: userId })
      res.json(await readAccount(db, userId, options))
    })
  )
  router.post(
    '/me/account/password/reset',
    withAsync(async (req, res) => {
      const userId = accountId(req)
      const pending = await db.transaction().execute(async tx => {
        const held = await lockAccount(tx, userId)
        await limit(tx, userId, 'passwordReset', 5)
        return await requestPasswordReset(tx, userId, held)
      })
      try {
        await options.sendCode(pending.email, pending.code)
      } catch {
        await db
          .updateTable('email_codes')
          .set({ consumed_at: new Date() })
          .where('id', '=', pending.id)
          .execute()
        throw unavailable('The email could not be sent. Please try again')
      }
      res.status(202).json({ requestId: pending.id, email: pending.email })
    })
  )
  router.post(
    '/me/account/emails/request',
    withAsync(async (req, res) => {
      const userId = accountId(req)
      const body = cleanBody(asAccountEmailRequest, req.body)
      const pending = await db.transaction().execute(async tx => {
        await lockAccount(tx, userId)
        await limit(tx, userId, 'emailRequest', 10, body.email)
        return await requestAccountEmail(
          tx,
          userId,
          body.email,
          body.replaceEmailId
        )
      })
      try {
        await options.sendCode(body.email, pending.code)
      } catch {
        await db
          .updateTable('email_codes')
          .set({ consumed_at: new Date() })
          .where('id', '=', pending.id)
          .execute()
        throw unavailable('The email could not be sent. Please try again')
      }
      res.status(202).json({ requestId: pending.id })
    })
  )
  router.post(
    '/me/account/emails/confirm',
    withAsync(async (req, res) => {
      const userId = accountId(req)
      const body = cleanBody(asAccountEmailConfirmation, req.body)
      let accepted: boolean
      try {
        accepted = await db.transaction().execute(async tx => {
          await lockAccount(tx, userId)
          await limit(tx, userId, 'emailConfirm', 20)
          return await confirmAccountEmail(
            tx,
            userId,
            body.requestId,
            body.code
          )
        })
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw conflict('That email address belongs to another account')
        throw error
      }
      if (!accepted)
        throw badRequest(
          'That code is incorrect or expired. Request a new code'
        )
      setAudit(res.locals, { entityType: 'user', entityId: userId })
      res.json(await readAccount(db, userId, options))
    })
  )
  router.put(
    '/me/account/emails/primary',
    withAsync(async (req, res) => {
      const userId = accountId(req)
      const body = cleanBody(asAccountPrimaryBody, req.body)
      await db.transaction().execute(async tx => {
        await lockAccount(tx, userId)
        await selectPrimaryEmail(tx, userId, body.emailId)
      })
      setAudit(res.locals, { entityType: 'user', entityId: userId })
      res.json(await readAccount(db, userId, options))
    })
  )
  return router
}
