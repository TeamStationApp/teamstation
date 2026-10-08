import type { Request } from 'express'
import { type Kysely, sql } from 'kysely'
import Provider, { interactionPolicy } from 'oidc-provider'

import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { makeOAuthAdapter, oauthHash } from './adapter'
import { loadOAuthSecrets, type OAuthConfig } from './config'

export async function activeHuman(
  db: Kysely<Database>,
  actor: Actor | undefined
): Promise<Actor | undefined> {
  if (actor?.sessionId == null || actor.apiTokenId != null) return undefined
  const row = await db
    .selectFrom('auth_sessions')
    .innerJoin('users', 'users.id', 'auth_sessions.user_id')
    .select('users.id')
    .where('users.id', '=', actor.userId)
    .where('auth_sessions.id', '=', actor.sessionId)
    .where('auth_sessions.revoked_at', 'is', null)
    .where('auth_sessions.expires_at', '>', new Date())
    .where('users.login_enabled', '=', true)
    .where('users.merged_into', 'is', null)
    .executeTakeFirst()
  return row == null ? undefined : actor
}

export function createOAuthProvider(
  db: Kysely<Database>,
  config: OAuthConfig,
  origin: string
): Provider {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin)
    throw new Error('OAuth requires a canonical HTTPS origin')
  const secrets = loadOAuthSecrets(config)
  const policy = interactionPolicy.base()
  policy.get('login')!.checks.add(
    new interactionPolicy.Check(
      'human_session_changed',
      'Confirm the current TeamStation account',
      async ctx => {
        // A native decision authenticates this one interaction without moving
        // the native TeamStation session token into the browser.
        if (ctx.oidc.result?.login != null) return false
        const actor = await activeHuman(db, (ctx.req as Request).actor)
        return (
          actor == null || String(actor.userId) !== ctx.oidc.session?.accountId
        )
      }
    )
  )
  const provider = new Provider(`${origin}/oauth`, {
    adapter: makeOAuthAdapter(db, secrets.storageKey),
    jwks: secrets.jwks,
    cookies: {
      keys: secrets.cookieKeys,
      long: { secure: true, httpOnly: true, sameSite: 'lax' },
      short: { secure: true, httpOnly: true, sameSite: 'lax' }
    },
    clients: config.clients.map(client => ({
      client_id: client.id,
      client_name: client.name,
      client_secret: client.secret,
      redirect_uris: client.redirectUris,
      response_types: ['code'],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'client_secret_basic'
    })),
    claims: {
      openid: ['sub'],
      profile: ['name'],
      email: ['email', 'email_verified']
    },
    scopes: ['openid', 'profile', 'email'],
    responseTypes: ['code'],
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: false }
    },
    ttl: {
      AuthorizationCode: 300,
      AccessToken: 300,
      IdToken: 300,
      Interaction: 600,
      Session: 2592000,
      Grant: 2592000
    },
    interactions: {
      policy,
      url: (_ctx, interaction) => `${origin}/oauth/approve/${interaction.uid}`
    },
    findAccount: async (_ctx, id) => {
      if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))
        return undefined
      const user = await db
        .selectFrom('users')
        .select(['id', 'display_name'])
        .where('id', '=', Number(id))
        .where('login_enabled', '=', true)
        .where('merged_into', 'is', null)
        .executeTakeFirst()
      if (user == null) return undefined
      return {
        accountId: id,
        claims: async () => {
          const email = await db
            .selectFrom('user_emails')
            .select(['email', 'verified_at'])
            .where('user_id', '=', user.id)
            .where('is_primary', '=', true)
            .executeTakeFirst()
          return {
            sub: id,
            name: user.display_name,
            ...(email == null
              ? {}
              : {
                  email: email.email,
                  email_verified: email.verified_at != null
                })
          }
        }
      }
    },
    renderError: (ctx, _out, error) => {
      ctx.status =
        'status' in error && typeof error.status === 'number'
          ? error.status
          : 400
      ctx.body = { error: 'OAuth request could not be completed' }
    }
  })
  provider.proxy = true
  // Cookie redirects and codes are intentionally absent from application logs.
  provider.on('server_error', () => {
    console.error('OAuth provider request failed')
  })
  return provider
}

/** Grants remain bound to the human login that approved them. */
export async function bindGrant(
  db: Kysely<Database>,
  grantId: string,
  clientId: string,
  actor: Actor
): Promise<void> {
  await sql`insert into oauth_grant_sessions (grant_hash, client_id, user_id, session_id)
    values (${oauthHash(grantId)}, ${clientId}, ${actor.userId}, ${actor.sessionId})
    on conflict (grant_hash) do update set session_id = excluded.session_id`.execute(
    db
  )
}
