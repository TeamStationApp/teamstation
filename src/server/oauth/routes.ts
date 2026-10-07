import { randomBytes, timingSafeEqual } from 'node:crypto'

import { asBoolean, asObject, asString } from 'cleaners'
import {
  type ErrorRequestHandler,
  json,
  type Request,
  type Response,
  Router
} from 'express'
import { type Kysely, sql } from 'kysely'
import type Provider from 'oidc-provider'

import {
  badRequest,
  forbidden,
  HttpError,
  unauthorized
} from '../../common/errors'
import { bearerToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { withAsync } from '../middleware/withErrors'
import { oauthHash } from './adapter'
import { activeHuman, bindGrant } from './provider'

const CSRF_COOKIE = '__Host-oauth-approval'
const cleanDecision = asObject({ approve: asBoolean })
function asDecision(value: unknown): { approve: boolean } {
  const result = cleanDecision(value)
  if (Object.keys(value as object).some(key => key !== 'approve'))
    throw badRequest('Unexpected approval field')
  return result
}
const asNativeRow = asObject({ interaction_id: asString, decision: asString })

function browserProof(req: Request, origin: string): void {
  const header = req.header('x-oauth-csrf') ?? ''
  const cookie =
    (req.header('cookie') ?? '')
      .split(';')
      .map(s => s.trim())
      .find(s => s.startsWith(`${CSRF_COOKIE}=`))
      ?.slice(CSRF_COOKIE.length + 1) ?? ''
  if (
    req.header('origin') !== origin ||
    !/^[A-Za-z0-9_-]{43}$/.test(header) ||
    cookie.length !== header.length ||
    !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))
  )
    throw forbidden()
}

export function oauthInteractionRoutes(
  db: Kysely<Database>,
  provider: Provider,
  origin: string
): Router {
  const router = Router()
  router.use(
    ['/oauth/approve', '/api/v1/oauth/approvals'],
    (_req, res, next) => {
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      next()
    }
  )
  const details = async (
    req: Request,
    res: Response
  ): Promise<Awaited<ReturnType<Provider['interactionDetails']>>> => {
    const interaction = await provider.interactionDetails(req, res)
    if (interaction.uid !== req.params.uid) throw forbidden()
    return interaction
  }
  const present = async (
    interaction: Awaited<ReturnType<Provider['interactionDetails']>>
  ): Promise<{ clientName: string; scopes: string[] }> => {
    const clientId = asString(interaction.params.client_id)
    const client = await provider.Client.find(clientId)
    if (client == null) throw forbidden()
    return {
      clientName: client.clientName ?? clientId,
      scopes: asString(interaction.params.scope)
        .split(' ')
        .filter(scope => ['openid', 'profile', 'email'].includes(scope))
    }
  }
  const finish = async (
    req: Request,
    res: Response,
    approve: boolean,
    actor = req.actor
  ): Promise<void> => {
    const interaction = await details(req, res)
    if (approve && (await activeHuman(db, actor)) == null) throw unauthorized()
    const claimed =
      await sql`insert into oauth_decisions (interaction_id, expires_at)
      values (${interaction.uid}, ${new Date(interaction.exp * 1000)})
      on conflict do nothing returning interaction_id`.execute(db)
    if (claimed.rows.length !== 1) throw badRequest('Approval already decided')
    if (!approve) {
      const redirectTo = await provider.interactionResult(
        req,
        res,
        { error: 'access_denied' },
        { mergeWithLastSubmission: false }
      )
      res.json({ redirectTo })
      return
    }
    const human = await activeHuman(db, actor)
    if (human?.sessionId == null) throw unauthorized()
    const clientId = asString(interaction.params.client_id)
    const grant = new provider.Grant({
      accountId: String(human.userId),
      clientId
    })
    const scope = asString(interaction.params.scope)
    grant.addOIDCScope(scope)
    const grantId = await grant.save()
    await bindGrant(db, grantId, clientId, human)
    const redirectTo = await provider.interactionResult(
      req,
      res,
      {
        login: { accountId: String(human.userId) },
        consent: { grantId }
      },
      { mergeWithLastSubmission: false }
    )
    res.json({ redirectTo })
  }
  router.get(
    '/oauth/approve/:uid/details',
    withAsync(async (req, res) => {
      const interaction = await details(req, res)
      const nativeRows = await sql<{
        decision: string
      }>`select decision from oauth_approvals
        where interaction_id = ${interaction.uid} and expires_at > now() and consumed_at is null`.execute(
        db
      )
      const nativeDecision = nativeRows.rows[0]
      const csrfToken = randomBytes(32).toString('base64url')
      res.cookie(CSRF_COOKIE, csrfToken, {
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        maxAge: 600000
      })
      res.json({
        ...(await present(interaction)),
        csrfToken,
        decision: nativeDecision?.decision,
        signedIn: (await activeHuman(db, req.actor)) != null
      })
    })
  )
  router.post(
    '/oauth/approve/:uid/decision',
    json({ limit: '16kb' }),
    withAsync(async (req, res) => {
      browserProof(req, origin)
      await finish(req, res, asDecision(req.body).approve)
    })
  )
  router.post(
    '/oauth/approve/:uid/native',
    json({ limit: '16kb' }),
    withAsync(async (req, res) => {
      browserProof(req, origin)
      const interaction = await details(req, res)
      const handle = randomBytes(32).toString('base64url')
      // Replacing a still-pending handle is safe; a completed approval cannot be reset.
      const result =
        await sql`insert into oauth_approvals (handle_hash, interaction_id, expires_at)
      values (${oauthHash(handle)}, ${interaction.uid}, ${new Date(Date.now() + 300000)})
      on conflict (interaction_id) do update set handle_hash = excluded.handle_hash, expires_at = excluded.expires_at
      where oauth_approvals.decision = 'pending' and oauth_approvals.consumed_at is null
      returning handle_hash`.execute(db)
      if (result.rows.length !== 1) throw badRequest('Approval already decided')
      res.json({
        appUrl: `teamstation:///oauth/native-approval/${handle}`,
        resumeUrl: `${origin}/oauth/approve/${interaction.uid}`
      })
    })
  )
  router.post(
    '/oauth/approve/:uid/resume',
    json({ limit: '16kb' }),
    withAsync(async (req, res) => {
      browserProof(req, origin)
      const interaction = await details(req, res)
      const found = await sql<{
        decision: string
        user_id: number
        session_id: string
      }>`
      update oauth_approvals set consumed_at = now()
      where interaction_id = ${interaction.uid} and expires_at > now() and consumed_at is null and decision <> 'pending'
      returning decision, user_id, session_id`.execute(db)
      const row = found.rows[0]
      if (row == null) {
        res.json({ pending: true })
        return
      }
      await finish(req, res, row.decision === 'approved', {
        userId: row.user_id,
        sessionId: row.session_id,
        isAdmin: false,
        scopes: []
      })
    })
  )
  const native = async (
    req: Request
  ): Promise<{ interaction_id: string; decision: string }> => {
    if ((await activeHuman(db, req.actor)) == null) throw unauthorized()
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(req.params.handle)))
      throw badRequest('Invalid approval')
    const found = await sql`select interaction_id, decision from oauth_approvals
      where handle_hash = ${oauthHash(String(req.params.handle))} and expires_at > now() and consumed_at is null`.execute(
      db
    )
    if (found.rows.length !== 1)
      throw badRequest('Approval expired or unavailable')
    return asNativeRow(found.rows[0])
  }
  router.get(
    '/api/v1/oauth/approvals/:handle',
    withAsync(async (req, res) => {
      const row = await native(req)
      const interaction = await provider.Interaction.find(row.interaction_id)
      if (interaction == null) throw badRequest('Approval expired')
      res.json({
        ...(await present(interaction)),
        decision: row.decision,
        resumeUrl: `${origin}/oauth/approve/${interaction.uid}`
      })
    })
  )
  router.post(
    '/api/v1/oauth/approvals/:handle',
    json({ limit: '16kb' }),
    withAsync(async (req, res) => {
      if (
        bearerToken(req.header('authorization')) == null ||
        req.header('origin') != null
      )
        throw forbidden()
      await native(req)
      const decision = asDecision(req.body).approve ? 'approved' : 'denied'
      const result =
        await sql`update oauth_approvals set decision = ${decision}, user_id = ${req.actor!.userId}, session_id = ${req.actor!.sessionId}
      where handle_hash = ${oauthHash(String(req.params.handle))} and decision = 'pending' and expires_at > now() and consumed_at is null
      returning interaction_id`.execute(db)
      if (result.rows.length !== 1) throw badRequest('Approval already decided')
      res.json({ approved: decision === 'approved' })
    })
  )
  const hideErrors: ErrorRequestHandler = (error, _req, res, _next) => {
    // Protocol handles, codes and parser input must not reach the generic
    // application's request/error logger.
    const status = error instanceof HttpError ? error.status : 400
    res
      .status(status)
      .json({ error: status === 401 ? 'unauthorized' : 'invalid_approval' })
  }
  router.use(hideErrors)
  return router
}
