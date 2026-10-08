import '../../test/fixtureRoots.test'

import { execFileSync, spawn } from 'node:child_process'
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  X509Certificate
} from 'node:crypto'
import { once } from 'node:events'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { expect } from 'chai'
import express from 'express'
import { JSDOM } from 'jsdom'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import * as client from 'openid-client'
import { Pool } from 'pg'
import { Agent } from 'undici'

import { verifyOAuthWeb } from '../../app/oauth/oauthWeb.e2e'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { createSession } from '../auth/sessions'
import { hashToken, makeToken } from '../auth/tokens'
import { type Database, makeDatabase } from '../db/database'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { meRoutes } from '../routes/me'
import {
  makeOAuthAdapter,
  oauthHash,
  openPayload,
  sealPayload
} from './adapter'
import { loadOAuthSecrets, type OAuthConfig } from './config'
import {
  oauthRequestLimit,
  pruneOAuth,
  scheduleOAuthPrune
} from './maintenance'
import { createOAuthProvider } from './provider'
import { oauthInteractionRoutes } from './routes'

const name = `TeamStation_teamstationBuilds_oauth_${process.pid}`
const databaseUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
const redirectUri = 'https://client.example.test/callback'
const secret = 'fixture-client-secret-with-sufficient-entropy'

class Browser {
  cookies = new Map<string, string>()
  constructor(private readonly fetcher: typeof fetch) {}
  async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(url, {
      ...init,
      redirect: 'manual',
      headers: {
        cookie: [...this.cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join('; '),
        ...Object.fromEntries(new Headers(init.headers))
      }
    })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const at = pair.indexOf('=')
      this.cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    return response
  }
}

describe('OAuth provider and native approval over HTTPS', function () {
  this.timeout(process.env.TS_OAUTH_WEB_E2E === '1' ? 180000 : 60000)
  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  let dir: string
  let server: Server
  let origin: string
  let agent: Agent
  let fetcher: typeof fetch
  let config: OAuthConfig
  let rp: client.Configuration
  let session: Awaited<ReturnType<typeof createSession>>
  let backendPort: number | undefined
  let serveUi = false
  let lastCallback: URL | undefined
  before(async () => {
    const root = process.env.TS_BUILDS_TEST_ROOT
    if (root == null)
      throw new Error(
        'Set TS_BUILDS_TEST_ROOT to an owned test artifact directory'
      )
    await mkdir(root, { recursive: true })
    dir = await mkdtemp(path.join(root, 'oauth-'))
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:app.example.test',
        '-keyout',
        path.join(dir, 'tls.key'),
        '-out',
        path.join(dir, 'tls.crt')
      ],
      { stdio: 'ignore' }
    )
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    config = {
      enabled: true,
      signingKeysFile: path.join(dir, 'signing.json'),
      storageKeyFile: path.join(dir, 'storage.key'),
      cookieKeysFile: path.join(dir, 'cookies.json'),
      clients: [
        {
          id: 'fixture-client',
          name: 'Example builds',
          secret,
          redirectUris: [redirectUri]
        }
      ]
    }
    await writeFile(
      config.signingKeysFile,
      JSON.stringify({
        keys: [
          {
            kid: 'fixture',
            pem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
          }
        ]
      }),
      { mode: 0o600 }
    )
    await writeFile(
      config.storageKeyFile,
      randomBytes(32).toString('base64url'),
      { mode: 0o600 }
    )
    await writeFile(
      config.cookieKeysFile,
      JSON.stringify([randomBytes(32).toString('base64url')]),
      { mode: 0o600 }
    )
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database "${name}"`)
    pool = new Pool({ connectionString: databaseUrl })
    await migrateUp(pool, migrations)
    db = makeDatabase(databaseUrl)
    await db
      .insertInto('users')
      .values({
        id: 123,
        legacyId: 'usr_AAAAAAAAAAAAAAAA',
        display_name: 'Alex Lee',
        login_enabled: true
      })
      .execute()
    await db
      .insertInto('user_emails')
      .values({
        id: 'uem_fixture',
        user_id: 123,
        email: 'alex@example.test',
        is_primary: true,
        verified_at: new Date()
      })
      .execute()
    session = await createSession(db, 123, 'fixture')
    await pool.query(
      "insert into teams (id,name) values ('tem_builds_fixture','Demo Hawks')"
    )
    await pool.query(
      "insert into invites (id,code,scope_type,scope_id,created_by) values ('inv_builds_fixture','demo-builds','team','tem_builds_fixture',123)"
    )
    const app = express()
    const ui = express()
    ui.use(express.static(path.resolve('dist')))
    ui.get('/{*path}', (_req, res) => {
      res.sendFile(path.resolve('dist/index.html'))
    })
    server = createServer(
      {
        key: await readFile(path.join(dir, 'tls.key')),
        cert: await readFile(path.join(dir, 'tls.crt'))
      },
      (req, res) => {
        if (serveUi && req.url?.startsWith('/fixture/callback') === true) {
          lastCallback = new URL(req.url, origin)
          res.end('Authorization complete')
          return
        }
        if (
          serveUi &&
          ((req.url?.startsWith('/api/') !== true &&
            req.url?.startsWith('/oauth/') !== true) ||
            /^\/oauth\/approve\/[A-Za-z0-9_-]+$/.test(req.url ?? ''))
        ) {
          ui(req, res)
          return
        }
        if (backendPort == null) {
          app(req, res)
          return
        }
        const upstream = httpRequest(
          {
            hostname: '127.0.0.1',
            port: backendPort,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, 'x-forwarded-proto': 'https' }
          },
          reply => {
            res.writeHead(reply.statusCode ?? 502, reply.headers)
            reply.pipe(res)
          }
        )
        upstream.on('error', () => {
          res.writeHead(502)
          res.end()
        })
        req.pipe(upstream)
      }
    ).listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    origin = `https://app.example.test:${(server.address() as AddressInfo).port}`
    config.clients[0].redirectUris.push(`${origin}/fixture/callback`)
    app.use(withActor(db))
    app.use(oauthRequestLimit(db))
    const provider = createOAuthProvider(db, config, origin)
    app.use(oauthInteractionRoutes(db, provider, origin))
    app.use('/oauth', provider.callback())
    app.use('/api/v1', meRoutes(db))
    app.use(errorHandler)
    agent = new Agent({
      connect: {
        ca: await readFile(path.join(dir, 'tls.crt')),
        lookup: (_hostname, _options, callback) => {
          callback(null, [{ address: '127.0.0.1', family: 4 }])
        }
      }
    })
    fetcher = async (input, init) => {
      const options: RequestInit = { ...init }
      Object.assign(options, { dispatcher: agent })
      return await fetch(input, options)
    }
    rp = await client.discovery(
      new URL(`${origin}/oauth`),
      'fixture-client',
      secret,
      client.ClientSecretBasic(secret),
      { [client.customFetch]: fetcher }
    )
  })
  after(async () => {
    if (server != null)
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    if (agent != null) await agent.close()
    if (db != null) await db.destroy()
    if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists "${name}"`)
      await admin.end()
    }
    if (dir != null) await rm(dir, { recursive: true })
  })
  async function start(browser = new Browser(fetcher)): Promise<{
    browser: Browser
    verifier: string
    state: string
    nonce: string
    approval: string
    csrf: string
  }> {
    const verifier = client.randomPKCECodeVerifier()
    const state = client.randomState()
    const nonce = client.randomNonce()
    const url = client.buildAuthorizationUrl(rp, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce
    })
    const response = await browser.request(url)
    expect(response.status).equals(303)
    const approval = response.headers.get('location')!
    const detail = await browser.request(`${approval}/details`)
    expect(detail.status).equals(200)
    const data = (await detail.json()) as {
      csrfToken: string
      clientName: string
    }
    expect(data.clientName).equals('Example builds')
    return { browser, verifier, state, nonce, approval, csrf: data.csrfToken }
  }
  async function post(
    flow: Awaited<ReturnType<typeof start>>,
    route: string,
    body: unknown
  ): Promise<Response> {
    return await flow.browser.request(flow.approval + route, {
      method: 'POST',
      headers: {
        origin,
        'x-oauth-csrf': flow.csrf,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
  }
  async function callback(
    flow: Awaited<ReturnType<typeof start>>,
    response: Response
  ): Promise<URL> {
    expect(response.status).equals(200)
    const { redirectTo } = (await response.json()) as { redirectTo: string }
    let resumed = await flow.browser.request(redirectTo)
    // The provider clears an older OIDC account with a self-submitting form
    // before resuming a deliberate switch to another TeamStation account.
    for (let count = 0; count < 4; count++) {
      if (resumed.status === 200) {
        const dom = new JSDOM(await resumed.text())
        const form = dom.window.document.querySelector('form')
        const action = new URL(form?.getAttribute('action') ?? '', origin)
        expect(action.origin).equals(origin)
        const body = new URLSearchParams()
        for (const input of dom.window.document.querySelectorAll('input'))
          body.set(input.name, input.value)
        dom.window.close()
        resumed = await flow.browser.request(action, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        })
      } else {
        const location = resumed.headers.get('location')
        if (location == null || new URL(location, origin).origin !== origin)
          break
        resumed = await flow.browser.request(new URL(location, origin))
      }
    }
    expect(resumed.status).equals(303)
    return new URL(resumed.headers.get('location')!)
  }
  it('issues a standards-client authorization code and verified identity after human approval', async () => {
    const flow = await start()
    flow.browser.cookies.set('ts_session', session.token)
    const url = await callback(
      flow,
      await post(flow, '/decision', { approve: true })
    )
    expect(url.origin).equals(new URL(redirectUri).origin)
    const tokens = await client.authorizationCodeGrant(rp, url, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce
    })
    expect(tokens.claims()?.sub).equals('123')
    const info = await client.fetchUserInfo(rp, tokens.access_token, '123')
    expect(info.email).equals('alex@example.test')
    expect(info.email_verified).equals(true)
    try {
      await client.authorizationCodeGrant(rp, url, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce
      })
      throw new Error('code unexpectedly reused')
    } catch (error) {
      expect((error as Error).message).not.equals('code unexpectedly reused')
    }
    const rows = await pool.query('select payload from oauth_records')
    expect(
      rows.rows.every(
        row =>
          !String(row.payload).includes('alex@example.test') &&
          !String(row.payload).includes('accountId')
      )
    ).equals(true)
  })
  it('lets the native human approve while only the original browser completes', async () => {
    const flow = await start()
    const native = await post(flow, '/native', {})
    expect(native.status).equals(200)
    const { appUrl } = (await native.json()) as { appUrl: string }
    const handle = appUrl.split('/').at(-1)!
    const headers = {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json'
    }
    const detail = await fetcher(`${origin}/api/v1/oauth/approvals/${handle}`, {
      headers
    })
    expect(detail.status).equals(200)
    expect(((await detail.json()) as { clientName: string }).clientName).equals(
      'Example builds'
    )
    const approved = await fetcher(
      `${origin}/api/v1/oauth/approvals/${handle}`,
      { method: 'POST', headers, body: '{"approve":true}' }
    )
    expect(approved.status).equals(200)
    const stolen = new Browser(fetcher)
    const rejected = await stolen.request(flow.approval + '/resume', {
      method: 'POST',
      headers: {
        origin,
        'x-oauth-csrf': flow.csrf,
        'content-type': 'application/json'
      },
      body: '{}'
    })
    expect(rejected.status).equals(403)
    const url = await callback(flow, await post(flow, '/resume', {}))
    const tokens = await client.authorizationCodeGrant(rp, url, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce
    })
    expect(tokens.claims()?.sub).equals('123')
    expect(
      (
        await fetcher(`${origin}/api/v1/oauth/approvals/${handle}`, {
          method: 'POST',
          headers,
          body: '{"approve":true}'
        })
      ).status
    ).equals(400)
  })
  it('does not reuse an OAuth identity after the TeamStation account changes', async () => {
    const first = await start()
    first.browser.cookies.set('ts_session', session.token)
    await callback(first, await post(first, '/decision', { approve: true }))
    await db
      .insertInto('users')
      .values({
        id: 456,
        legacyId: 'usr_BBBBBBBBBBBBBBBB',
        display_name: 'Jordan Smith',
        login_enabled: true
      })
      .execute()
    const other = await createSession(db, 456, 'fixture')
    first.browser.cookies.set('ts_session', other.token)
    const changed = await start(first.browser)
    const url = await callback(
      changed,
      await post(changed, '/decision', { approve: true })
    )
    const tokens = await client.authorizationCodeGrant(rp, url, {
      pkceCodeVerifier: changed.verifier,
      expectedState: changed.state,
      expectedNonce: changed.nonce
    })
    expect(tokens.claims()?.sub).equals('456')
    first.browser.cookies.delete('ts_session')
    const signedOut = await start(first.browser)
    expect(
      (await post(signedOut, '/decision', { approve: true })).status
    ).equals(401)
  })
  it('denies untrusted web origins, anonymous approval and user denial', async () => {
    const flow = await start()
    expect((await post(flow, '/decision', { approve: true })).status).equals(
      401
    )
    flow.browser.cookies.set('ts_session', session.token)
    expect(
      (
        await flow.browser.request(flow.approval + '/decision', {
          method: 'POST',
          headers: {
            origin: 'https://evil.example.test',
            'x-oauth-csrf': flow.csrf,
            'content-type': 'application/json'
          },
          body: '{"approve":true}'
        })
      ).status
    ).equals(403)
    const url = await callback(
      flow,
      await post(flow, '/decision', { approve: false })
    )
    expect(url.searchParams.get('error')).equals('access_denied')
  })
  it('invalidates a code when the approving login is revoked', async () => {
    const flow = await start()
    flow.browser.cookies.set('ts_session', session.token)
    const url = await callback(
      flow,
      await post(flow, '/decision', { approve: true })
    )
    await db
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date() })
      .where('id', '=', session.sessionId)
      .execute()
    try {
      await client.authorizationCodeGrant(rp, url, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce
      })
      throw new Error('revoked login accepted')
    } catch (error) {
      expect((error as Error).message).not.equals('revoked login accepted')
    }
    await db
      .updateTable('auth_sessions')
      .set({ revoked_at: null })
      .where('id', '=', session.sessionId)
      .execute()
  })
  it('stores authenticated encrypted records and atomically consumes once', async () => {
    const key = randomBytes(32)
    const Adapter = makeOAuthAdapter(db, key)
    const first = new Adapter('Fixture')
    await first.upsert(
      'fixture-id',
      { uid: 'fixture-uid', userCode: 'fixture-user-code', accountId: '123' },
      60
    )
    const restarted = new Adapter('Fixture')
    expect((await restarted.findByUid('fixture-uid'))?.accountId).equals('123')
    expect(
      (await restarted.findByUserCode('fixture-user-code'))?.accountId
    ).equals('123')
    const results = await Promise.allSettled([
      first.consume('fixture-id'),
      restarted.consume('fixture-id')
    ])
    expect(results.filter(r => r.status === 'fulfilled').length).equals(1)
    expect((await first.find('fixture-id'))?.consumed).equals(true)
    await first.destroy('fixture-id')
    expect(await first.find('fixture-id')).equals(undefined)
    await first.upsert('expired', {}, -1)
    expect(await first.find('expired')).equals(undefined)
    const sealed = sealPayload({ example: true }, key, 'Fixture')
    expect(openPayload(sealed, key, 'Fixture')).deep.equals({ example: true })
    expect(() => openPayload(sealed, key, 'Another')).throws()
    expect(oauthHash('fixture')).has.length(64)
  })
  it('fails closed for insecure private keys and invalid client redirects', async () => {
    await chmod(config.storageKeyFile, 0o644)
    expect(() => loadOAuthSecrets(config)).throws(
      'OAuth private configuration is invalid'
    )
    await chmod(config.storageKeyFile, 0o600)
    expect(() =>
      loadOAuthSecrets({
        ...config,
        clients: [
          {
            ...config.clients[0],
            redirectUris: ['http://example.test/callback']
          }
        ]
      })
    ).throws()
    expect(() =>
      createOAuthProvider(db, config, 'http://example.test')
    ).throws()
  })
  it('rejects missing PKCE, unregistered redirects, wrong verifiers and expired codes', async () => {
    const url = client.buildAuthorizationUrl(rp, {
      redirect_uri: redirectUri,
      scope: 'openid',
      state: 'fixture'
    })
    expect((await fetcher(url, { redirect: 'manual' })).status).equals(303)
    url.searchParams.set(
      'redirect_uri',
      'https://unregistered.example.test/callback'
    )
    expect((await fetcher(url, { redirect: 'manual' })).status).equals(400)
    for (const expired of [false, true]) {
      const flow = await start()
      flow.browser.cookies.set('ts_session', session.token)
      const callbackUrl = await callback(
        flow,
        await post(flow, '/decision', { approve: true })
      )
      if (expired)
        await pool.query(
          "update oauth_records set expires_at = now() - interval '1 second' where model = 'AuthorizationCode'"
        )
      try {
        await client.authorizationCodeGrant(rp, callbackUrl, {
          pkceCodeVerifier: expired
            ? flow.verifier
            : client.randomPKCECodeVerifier(),
          expectedState: flow.state,
          expectedNonce: flow.nonce
        })
        throw new Error('invalid code accepted')
      } catch (error) {
        expect((error as Error).message).not.equals('invalid code accepted')
      }
    }
  })
  it('does not certify an unverified email or accept caller identity fields', async () => {
    await db
      .updateTable('user_emails')
      .set({ verified_at: null })
      .where('user_id', '=', 123)
      .execute()
    const flow = await start()
    flow.browser.cookies.set('ts_session', session.token)
    expect(
      (await post(flow, '/decision', { approve: true, userId: 456 })).status
    ).equals(400)
    const url = await callback(
      flow,
      await post(flow, '/decision', { approve: true })
    )
    const tokens = await client.authorizationCodeGrant(rp, url, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce
    })
    expect(
      (await client.fetchUserInfo(rp, tokens.access_token, '123'))
        .email_verified
    ).equals(false)
    await db
      .updateTable('user_emails')
      .set({ verified_at: new Date() })
      .where('user_id', '=', 123)
      .execute()
  })
  it('rejects machine tokens and disabled or merged accounts at approval', async () => {
    const flow = await start()
    const response = await post(flow, '/native', {})
    const handle = ((await response.json()) as { appUrl: string }).appUrl
      .split('/')
      .at(-1)!
    const token = makeToken()
    await db
      .insertInto('api_tokens')
      .values({
        id: 'api_fixture',
        user_id: 123,
        token_hash: hashToken(token),
        label: 'fixture',
        scopes: []
      })
      .execute()
    const decision = async (credential: string): Promise<Response> =>
      await fetcher(`${origin}/api/v1/oauth/approvals/${handle}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ approve: true })
      })
    expect((await decision(token)).status).equals(401)
    await db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', 123)
      .execute()
    expect((await decision(session.token)).status).equals(401)
    await db
      .updateTable('users')
      .set({ login_enabled: true, merged_into: 123 })
      .where('id', '=', 123)
      .execute()
    expect((await decision(session.token)).status).equals(401)
    await db
      .updateTable('users')
      .set({ merged_into: null })
      .where('id', '=', 123)
      .execute()
  })
  it('keeps native approval pending until a decision and rejects expired handles', async () => {
    const flow = await start()
    const response = await post(flow, '/native', {})
    const handle = ((await response.json()) as { appUrl: string }).appUrl
      .split('/')
      .at(-1)!
    expect(await (await post(flow, '/resume', {})).json()).deep.equals({
      pending: true
    })
    await pool.query(
      "update oauth_approvals set expires_at = now() - interval '1 second' where handle_hash = $1",
      [oauthHash(handle)]
    )
    expect(
      (
        await fetcher(`${origin}/api/v1/oauth/approvals/${handle}`, {
          headers: { authorization: `Bearer ${session.token}` }
        })
      ).status
    ).equals(400)
  })
  it('omits the distribution link when it is not configured', async () => {
    const response = await fetcher(`${origin}/api/v1/me/builds`, {
      headers: { authorization: `Bearer ${session.token}` }
    })
    expect(response.status).equals(200)
    expect(await response.json()).deep.equals({})
  })
  it('prunes expired OAuth records and bounds repeated protocol requests', async () => {
    const timer = scheduleOAuthPrune(db, 10)
    try {
      await pruneOAuth(db)
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(
        (
          await pool.query(
            'select count(*) as n from oauth_records where expires_at <= now()'
          )
        ).rows[0].n
      ).equals(0)
      expect(
        (
          await pool.query(
            'select count(*) as n from oauth_approvals where expires_at <= now()'
          )
        ).rows[0].n
      ).equals(0)
    } finally {
      clearInterval(timer)
    }
    await pool.query(
      "insert into rate_events (id, scope, key, at) select 'fixture_rate_' || n, 'oauth.request', 'unknown', now() from generate_series(1,120) as n"
    )
    expect(
      (await fetcher(`${origin}/oauth/.well-known/openid-configuration`)).status
    ).equals(429)
    await pool.query("delete from rate_events where scope = 'oauth.request'")
  })
  it('authorizes through source and compiled server entrypoints and survives a restart', async () => {
    const repo = process.cwd()
    // Compilation is part of the entrypoint contract, not an alternate server fixture.
    execFileSync(
      path.join(repo, 'node_modules/.bin/tsc'),
      ['-p', 'tsconfig.server.json'],
      { stdio: 'pipe' }
    )
    const { createServer: createHttpServer } = await import('node:http')
    const reservation = createHttpServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = (reservation.address() as AddressInfo).port
    await new Promise<void>(resolve =>
      reservation.close(() => {
        resolve()
      })
    )
    await writeFile(
      path.join(dir, 'serverConfig.json'),
      JSON.stringify({
        oauth: config,
        buildsUrl: 'https://builds.example.test',
        databaseUrl,
        clusterWorkers: 1,
        statsBuilder: false,
        listenHost: '127.0.0.1',
        listenPort: port,
        primaryUrlOverride: new URL(origin).host,
        mediaDir: path.join(dir, 'media'),
        workDir: path.join(dir, 'work'),
        live: { enabled: false },
        logRequests: false,
        redis: { url: 'redis://127.0.0.1:1', prefix: 'fixture-oauth' },
        sessionSecret: randomBytes(32).toString('base64url'),
        mediaSecret: randomBytes(32).toString('base64url')
      }),
      { mode: 0o600 }
    )
    let previous: { token: string; sub: string } | undefined
    for (const compiled of [false, true]) {
      const args = compiled
        ? [path.join(repo, 'lib/server/index.js')]
        : [
            '-r',
            require.resolve('sucrase/register'),
            path.join(repo, 'src/server/index.ts')
          ]
      const child = spawn(process.execPath, args, {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      child.stdout.on('data', chunk => {
        output += String(chunk)
      })
      child.stderr.on('data', chunk => {
        output += String(chunk)
      })
      const stopped = once(child, 'exit')
      try {
        const deadline = Date.now() + 15000
        while (!output.includes('listening on')) {
          if (child.exitCode != null || Date.now() > deadline)
            throw new Error('OAuth server fixture did not start')
          await new Promise(resolve => setTimeout(resolve, 30))
        }
        backendPort = port
        const link = await fetcher(`${origin}/api/v1/me/builds`, {
          headers: { authorization: `Bearer ${session.token}` }
        })
        expect(await link.json()).deep.equals({
          url: 'https://builds.example.test'
        })
        expect((await fetcher(`${origin}/api/v1/me/builds`)).status).equals(401)
        const discovered = await client.discovery(
          new URL(`${origin}/oauth`),
          'fixture-client',
          secret,
          client.ClientSecretBasic(secret),
          { [client.customFetch]: fetcher }
        )
        if (previous != null)
          expect(
            (
              await client.fetchUserInfo(
                discovered,
                previous.token,
                previous.sub
              )
            ).sub
          ).equals('123')
        const flow = await start()
        flow.browser.cookies.set('ts_session', session.token)
        const url = await callback(
          flow,
          await post(flow, '/decision', { approve: true })
        )
        const tokens = await client.authorizationCodeGrant(discovered, url, {
          pkceCodeVerifier: flow.verifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce
        })
        previous = { token: tokens.access_token, sub: tokens.claims()!.sub }
        expect(
          (await client.fetchUserInfo(discovered, previous.token, '123'))
            .email_verified
        ).equals(true)
        expect(output).not.includes(session.token)
        expect(output).not.includes(secret)
        if (!compiled && process.env.TS_OAUTH_WEB_E2E === '1') {
          execFileSync(process.execPath, ['src/build.mjs'], {
            cwd: repo,
            stdio: 'pipe'
          })
          const browserBin = process.env.TS_TEST_BROWSER_BIN
          if (browserBin == null)
            throw new Error('Set TS_TEST_BROWSER_BIN for browser acceptance')
          const cert = new X509Certificate(
            await readFile(path.join(dir, 'tls.crt'))
          )
          const pin = createHash('sha256')
            .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
            .digest('base64')
          const wrapper = path.join(dir, 'fixture-browser')
          const quote = (value: string): string =>
            "'" + value.replace(/'/g, "'\\''") + "'"
          await writeFile(
            wrapper,
            `#!/bin/sh\nexec ${quote(browserBin)} --host-resolver-rules='MAP app.example.test 127.0.0.1' --ignore-certificate-errors-spki-list=${quote(pin)} "$@"\n`,
            { mode: 0o700 }
          )
          const verifier = client.randomPKCECodeVerifier()
          const state = client.randomState()
          const nonce = client.randomNonce()
          const authorize = client.buildAuthorizationUrl(discovered, {
            redirect_uri: `${origin}/fixture/callback`,
            scope: 'openid profile email',
            code_challenge: await client.calculatePKCECodeChallenge(verifier),
            code_challenge_method: 'S256',
            state,
            nonce
          })
          serveUi = true
          try {
            const callbackUrl = await verifyOAuthWeb({
              origin,
              browserBin: wrapper,
              sessionToken: session.token,
              authorizeUrl: authorize.href,
              waitForCallback: async () => {
                if (lastCallback == null) throw new Error('No browser callback')
                return lastCallback
              }
            })
            const browserTokens = await client.authorizationCodeGrant(
              discovered,
              callbackUrl,
              {
                pkceCodeVerifier: verifier,
                expectedState: state,
                expectedNonce: nonce
              }
            )
            expect(browserTokens.claims()?.sub).equals('123')
          } finally {
            serveUi = false
          }
        }
      } finally {
        backendPort = undefined
        child.kill('SIGTERM')
        const killer = setTimeout(() => child.kill('SIGKILL'), 11000)
        await stopped
        clearTimeout(killer)
      }
    }
    const configFile = path.join(dir, 'serverConfig.json')
    const invalid = JSON.parse(await readFile(configFile, 'utf8'))
    invalid.oauth.enabled = 'not-a-boolean'
    await writeFile(configFile, JSON.stringify(invalid))
    const rejected = spawn(
      process.execPath,
      [path.join(repo, 'lib/server/index.js')],
      {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let diagnostics = ''
    rejected.stderr.on('data', chunk => {
      diagnostics += String(chunk)
    })
    expect((await once(rejected, 'exit'))[0]).not.equals(0)
    expect(diagnostics).includes('Invalid server configuration')
    expect(diagnostics).not.includes(secret)
  })
})
