import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import express from 'express'
import { it } from 'mocha'
import { Pool } from 'pg'
import { Agent } from 'undici'

import { migrations } from '../../../src/migrate/migrations'
import { migrateUp } from '../../../src/migrate/runner'
import { testDatabaseUrl } from '../../../src/migrate/testDatabase'
import { createSession } from '../../../src/server/auth/sessions'
import { makeDatabase } from '../../../src/server/db/database'
import { withActor } from '../../../src/server/middleware/withAuth'
import { errorHandler } from '../../../src/server/middleware/withErrors'
import type { OAuthConfig } from '../../../src/server/oauth/config'
import { createOAuthProvider } from '../../../src/server/oauth/provider'
import { oauthInteractionRoutes } from '../../../src/server/oauth/routes'
import { testRoot } from '../config.test'
import { asRemote } from './config'
import { blocks, caddyCandidate, caddySite } from './templates'

async function port(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const value = (server.address() as AddressInfo).port
  await new Promise<void>(resolve =>
    server.close(() => {
      resolve()
    })
  )
  return value
}
const enabled =
  process.env.MASON_TEST_REPO != null && process.env.DEVOPS_TEST_REPO != null
;(enabled ? it : it.skip)(
  'routes actual TeamStation OAuth and Mason access through the DevOps Caddy template',
  async function () {
    this.timeout(60000)
    const masonRepo = process.env.MASON_TEST_REPO!
    const devops = process.env.DEVOPS_TEST_REPO!
    const root = testRoot('caddy-oauth-')
    const dbName = `TeamStation_buildsHosting_${process.pid}`
    const dbUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${dbName}`)
    const admin = new Pool({ connectionString: testDatabaseUrl })
    const pool = new Pool({ connectionString: dbUrl })
    let db: ReturnType<typeof makeDatabase> | undefined
    let created = false
    let caddy: ChildProcess | undefined
    let masonServer: Server | undefined
    let tsServer: Server | undefined
    let store: any
    let agent: Agent | undefined
    try {
      const appPort = await port()
      const masonPort = await port()
      const origin = `https://app.example.test:${appPort}`
      const masonOrigin = `https://builds.example.test:${masonPort}`
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
          '/CN=Fixture',
          '-addext',
          'subjectAltName=DNS:app.example.test,DNS:builds.example.test',
          '-keyout',
          `${root}/tls.key`,
          '-out',
          `${root}/tls.crt`
        ],
        { stdio: 'ignore' }
      )
      agent = new Agent({
        connect: {
          ca: readFileSync(`${root}/tls.crt`),
          lookup: (_host, _options, callback) => {
            callback(null, [{ address: '127.0.0.1', family: 4 }])
          }
        }
      })
      const transport: typeof fetch = async (input, init) =>
        await fetch(input, Object.assign({ ...init }, { dispatcher: agent }))
      await admin.query(`CREATE DATABASE "${dbName}"`)
      created = true
      await migrateUp(pool, migrations)
      db = makeDatabase(dbUrl)
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
      const session = await createSession(db, 123, 'fixture')
      const secret = randomBytes(32).toString('base64url')
      const oauth: OAuthConfig = {
        enabled: true,
        signingKeysFile: `${root}/signing.json`,
        storageKeyFile: `${root}/storage.txt`,
        cookieKeysFile: `${root}/cookies.json`,
        clients: [
          {
            id: 'distribution',
            name: 'Example builds',
            secret,
            redirectUris: [`${masonOrigin}/auth/callback/application`]
          }
        ]
      }
      writeFileSync(
        oauth.signingKeysFile,
        JSON.stringify({
          keys: [
            {
              kid: 'fixture',
              pem: generateKeyPairSync('rsa', {
                modulusLength: 2048
              }).privateKey.export({ type: 'pkcs8', format: 'pem' })
            }
          ]
        }),
        { mode: 0o600 }
      )
      writeFileSync(
        oauth.storageKeyFile,
        randomBytes(32).toString('base64url'),
        { mode: 0o600 }
      )
      writeFileSync(oauth.cookieKeysFile, JSON.stringify([secret]), {
        mode: 0o600
      })
      const app = express()
      app.set('trust proxy', 'loopback')
      app.use(withActor(db))
      const provider = createOAuthProvider(db, oauth, origin)
      app.use(oauthInteractionRoutes(db, provider, origin))
      app.use('/oauth', provider.callback())
      app.get('/api/fixture', (_req, res) => res.json({ status: 'api' }))
      app.get('/socket', (_req, res) => res.send('socket'))
      app.get('/internal/media-auth', (_req, res) => res.sendStatus(200))
      app.use(errorHandler)
      tsServer = app.listen(0, '127.0.0.1')
      await once(tsServer, 'listening')
      const tsPort = (tsServer.address() as AddressInfo).port
      // Keep the other repository's native ESM outside Sucrase's CommonJS hook.
      const { load: nativeImport } = require('./nativeImport.mjs') as {
        load: (url: string) => Promise<any>
      }
      const load = async (file: string): Promise<any> =>
        await nativeImport(
          pathToFileURL(path.join(masonRepo, 'lib', file)).href
        )
      const { Store } = await load('store.js')
      const { asConfig } = await load('config.js')
      const { Accounts } = await load('auth/accounts.js')
      const { Providers } = await load('auth/providers.js')
      const { createApp } = await load('server.js')
      const masonConfig = asConfig({
        origin: masonOrigin,
        database: `${root}/mason.sqlite`,
        storage: `${root}/packages`,
        freeSpaceBytes: 0,
        providers: [
          {
            id: 'application',
            name: 'Example identity',
            type: 'oidc',
            issuer: `${origin}/oauth`,
            clientId: 'distribution',
            clientSecret: secret
          }
        ]
      })
      store = new Store(masonConfig)
      store.addApp({ slug: 'example', name: 'Example app', position: 0 })
      const accounts = new Accounts(store)
      masonServer = createApp(
        store,
        new Providers(masonOrigin, masonConfig.providers, transport)
      ).listen(0, '127.0.0.1') as Server
      await once(masonServer, 'listening')
      const backendPort = (masonServer.address() as AddressInfo).port
      const raw = readFileSync(
        path.join(devops, 'src/deploy/Caddyfile'),
        'utf8'
      )
      const parsed = blocks(raw)
      const snippet = parsed.find(block => block.header === '(teamstation)')!
      const site = parsed.find(block => block.header === 'app.teamstation.app')!
      assert(snippet != null && site != null)
      const log = parsed.find(
        block =>
          block.depth === 1 &&
          block.start > site.open &&
          block.end < site.end &&
          block.header === 'log'
      )!
      let siteText =
        raw.slice(site.start, log.start) + raw.slice(log.end, site.end)
      const assets = `${root}/assets`
      mkdirSync(`${assets}/downloads`, { recursive: true })
      mkdirSync(`${assets}/install`)
      mkdirSync(`${assets}/builds`)
      writeFileSync(`${assets}/index.html`, '<html>approval web shell</html>')
      writeFileSync(`${assets}/downloads/fixture.ipa`, 'download bytes')
      writeFileSync(`${assets}/install/fixture.plist`, '<plist/>')
      writeFileSync(`${assets}/builds/old.apk`, 'must not escape')
      writeFileSync(`${assets}/clip.ts`, 'media bytes')
      const remapRoots = (text: string): string =>
        text.replace(/root \* \/[^\s]+/g, `root * ${assets}`)
      siteText = remapRoots(siteText)
        .replace(
          'app.teamstation.app {',
          `app.example.test:${appPort} {\n tls ${root}/tls.crt ${root}/tls.key`
        )
        .replace(
          /import teamstation [0-9]+ \S+/,
          `import teamstation ${tsPort} ${assets}`
        )
      const base = `{\n admin off\n auto_https off\n}\nimport mason-sites/*.caddy\n${remapRoots(raw.slice(snippet.start, snippet.end))}\n${siteText}\n`
      const caddyFile = `${root}/Caddyfile`
      const caddyBin = process.env.CADDY_BINARY ?? '/opt/homebrew/bin/caddy'
      writeFileSync(caddyFile, base)
      execFileSync(
        caddyBin,
        ['validate', '--config', caddyFile, '--adapter', 'caddyfile'],
        { stdio: 'pipe' }
      )
      const remote = asRemote({
        root: `${root}/hosting`,
        node: '/usr/bin/node',
        npm: '/usr/bin/npm',
        user: 'distribution',
        group: 'distribution',
        service: 'distribution',
        systemdDirectory: `${root}/units`,
        caddyFile,
        caddyInclude: `${root}/mason-sites/site.caddy`,
        caddy: caddyBin,
        caddyService: 'web',
        protectedPaths: [`${root}/application`],
        teamstationOrigin: origin,
        teamstationSnippet: 'teamstation',
        port: backendPort,
        memoryBytes: 512 * 1024 ** 2,
        tasks: 128
      })
      mkdirSync(`${root}/mason-sites`)
      writeFileSync(
        remote.caddyInclude,
        caddySite(masonOrigin, backendPort).replace(
          '{\n',
          `{\n tls ${root}/tls.crt ${root}/tls.key\n`
        )
      )
      const candidate = caddyCandidate(base, remote, masonOrigin)
      writeFileSync(caddyFile, candidate)
      assert.equal(candidate.split('import mason-sites/*.caddy').length, 2)
      assert(!candidate.includes(`import ${remote.caddyInclude}`))
      const helper = path.join(devops, 'src/deploy/installCaddy.sh')
      execFileSync('bash', [helper, caddyFile, `${root}/InstalledCaddyfile`], {
        env: {
          ...process.env,
          PATH: `${path.dirname(caddyBin)}:${process.env.PATH}`
        },
        stdio: 'pipe'
      })
      writeFileSync(
        `${root}/unused-template`,
        'invalid {\n unknown_directive\n}\n'
      )
      execFileSync(
        'bash',
        [helper, `${root}/unused-template`, `${root}/InstalledCaddyfile`],
        {
          env: {
            ...process.env,
            PATH: `${path.dirname(caddyBin)}:${process.env.PATH}`
          },
          stdio: 'pipe'
        }
      )
      assert.equal(
        readFileSync(`${root}/InstalledCaddyfile`, 'utf8'),
        candidate
      )
      assert.throws(() =>
        execFileSync(
          'bash',
          [helper, `${root}/unused-template`, `${root}/RejectedCaddyfile`],
          {
            env: {
              ...process.env,
              PATH: `${path.dirname(caddyBin)}:${process.env.PATH}`
            },
            stdio: 'pipe'
          }
        )
      )
      caddy = spawn(
        caddyBin,
        ['run', '--config', caddyFile, '--adapter', 'caddyfile'],
        {
          stdio: 'ignore',
          env: {
            ...process.env,
            XDG_DATA_HOME: `${root}/caddy-data`,
            XDG_CONFIG_HOME: `${root}/caddy-config`
          }
        }
      )
      let ready = false
      for (let i = 0; i < 100; ++i) {
        try {
          ready = (await transport(`${masonOrigin}/health`)).ok
        } catch {}
        if (ready) break
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      assert(ready, 'Caddy and Mason became ready')
      const anonymous = new Agent({
        connect: {
          ca: readFileSync(`${root}/tls.crt`),
          lookup: (_host, _options, callback) => {
            callback(null, [{ address: '127.0.0.1', family: 4 }])
          }
        }
      })
      try {
        const denied = await fetch(
          `${masonOrigin}/`,
          Object.assign(
            { redirect: 'manual' as const },
            { dispatcher: anonymous }
          )
        )
        assert.equal(denied.status, 303)
        assert.match(denied.headers.get('location')!, /^\/auth\/login/)
        await denied.text()
      } finally {
        await anonymous.close()
      }
      for (const suffix of [
        '/builds',
        '/builds/',
        '/builds/old.apk?token=discarded'
      ]) {
        const reply = await transport(origin + suffix, { redirect: 'manual' })
        assert.equal(reply.status, 302)
        assert.equal(reply.headers.get('location'), `${masonOrigin}/`)
      }
      assert.equal(
        await (await transport(`${origin}/downloads/fixture.ipa`)).text(),
        'download bytes'
      )
      assert.equal(
        await (await transport(`${origin}/install/fixture.plist`)).text(),
        '<plist/>'
      )
      assert.equal((await transport(`${origin}/internal/fixture`)).status, 404)
      assert.equal(await (await transport(`${origin}/socket`)).text(), 'socket')
      assert.equal(
        await (await transport(`${origin}/media/1/fixture/clip.ts`)).text(),
        'media bytes'
      )
      assert.equal(
        (
          (await (await transport(`${origin}/api/fixture`)).json()) as {
            status: string
          }
        ).status,
        'api'
      )
      assert.equal(
        (
          (await (
            await transport(`${origin}/oauth/.well-known/openid-configuration`)
          ).json()) as { issuer: string }
        ).issuer,
        origin + '/oauth'
      )
      const cookies = new Map<string, Map<string, string>>()
      async function browse(
        url: string,
        init: RequestInit = {}
      ): Promise<Response> {
        const parsed = new URL(url)
        const jar = cookies.get(parsed.origin) ?? new Map<string, string>()
        cookies.set(parsed.origin, jar)
        const headers = new Headers(init.headers)
        headers.set(
          'cookie',
          [...jar].map(([key, value]) => `${key}=${value}`).join('; ')
        )
        const response = await transport(url, {
          ...init,
          headers,
          redirect: 'manual'
        })
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(';')[0]
          const at = pair.indexOf('=')
          jar.set(pair.slice(0, at), pair.slice(at + 1))
        }
        return response
      }
      cookies.set(origin, new Map([['ts_session', session.token]]))
      async function authorize(nativeToken?: string): Promise<void> {
        let response = await browse(`${masonOrigin}/auth/start/application`)
        assert.equal(response.status, 303)
        response = await browse(response.headers.get('location')!)
        assert.equal(response.status, 303)
        const approval = response.headers.get('location')!
        if (new URL(approval, origin).origin === masonOrigin) {
          const completed = await browse(approval)
          assert.equal(completed.status, 303)
          return
        }
        assert.match(
          await (await browse(approval)).text(),
          /approval web shell/
        )
        const details = await browse(approval + '/details')
        assert.equal(details.status, 200)
        const csrf = ((await details.json()) as { csrfToken: string }).csrfToken
        let decisionPath = '/decision'
        let decisionBody = JSON.stringify({ approve: true })
        if (nativeToken != null) {
          const issued = await browse(approval + '/native', {
            method: 'POST',
            headers: {
              origin,
              'content-type': 'application/json',
              'x-oauth-csrf': csrf
            },
            body: '{}'
          })
          assert.equal(issued.status, 200)
          const { appUrl } = (await issued.json()) as { appUrl: string }
          const handle = appUrl.split('/').at(-1)!
          const nativeHeaders = {
            authorization: `Bearer ${nativeToken}`,
            'content-type': 'application/json'
          }
          assert.equal(
            (
              await transport(`${origin}/api/v1/oauth/approvals/${handle}`, {
                headers: nativeHeaders
              })
            ).status,
            200
          )
          const approved = await transport(
            `${origin}/api/v1/oauth/approvals/${handle}`,
            { method: 'POST', headers: nativeHeaders, body: '{"approve":true}' }
          )
          assert.equal(approved.status, 200)
          decisionPath = '/resume'
          decisionBody = '{}'
        }
        response = await browse(approval + decisionPath, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-oauth-csrf': csrf
          },
          body: decisionBody
        })
        assert.equal(response.status, 200)
        response = await browse(
          ((await response.json()) as { redirectTo: string }).redirectTo
        )
        assert.equal(response.status, 303)
        const callback = response.headers.get('location')!
        assert(callback.startsWith(`${masonOrigin}/auth/callback/application?`))
        response = await browse(callback)
        assert.equal(response.status, 303)
      }
      await authorize()
      assert.match(
        await (await browse(masonOrigin + '/')).text(),
        /access|pending/i
      )
      assert(
        !(await (await browse(masonOrigin + '/')).text()).includes(
          'Example app'
        )
      )
      const id = accounts.promote('application', '123', 'alex@example.test')
      assert.equal(typeof id, 'number')
      cookies.delete(masonOrigin)
      await authorize()
      assert.match(
        await (await browse(masonOrigin + '/')).text(),
        /Example app/
      )
      assert.equal((await browse(masonOrigin + '/people')).status, 200)
      accounts.invite(id, 'application', 'jamie@example.test')
      assert.equal(accounts.identities().length, 1)
      await db
        .insertInto('users')
        .values({
          id: 124,
          legacyId: 'usr_BBBBBBBBBBBBBBBB',
          display_name: 'Jamie Lee',
          login_enabled: true
        })
        .execute()
      await db
        .insertInto('user_emails')
        .values({
          id: 'uem_invited',
          user_id: 124,
          email: 'jamie@example.test',
          is_primary: true,
          verified_at: new Date()
        })
        .execute()
      const invitedSession = await createSession(db, 124, 'fixture')
      cookies.delete(masonOrigin)
      cookies.set(origin, new Map([['ts_session', invitedSession.token]]))
      await authorize(invitedSession.token)
      const tester = accounts
        .identities()
        .find((item: { subject: string }) => item.subject === '124')!.account_id
      assert.equal(accounts.account(tester).is_tester, 1)
      assert.match(
        await (await browse(masonOrigin + '/')).text(),
        /Example app/
      )
      assert.equal((await browse(masonOrigin + '/people')).status, 403)
      accounts.setTester(id, tester, false)
      assert.equal((await browse(masonOrigin + '/')).status, 303)
      cookies.delete(masonOrigin)
      await authorize()
      assert(
        !(await (await browse(masonOrigin + '/')).text()).includes(
          'Example app'
        )
      )
      console.log(
        'HTTPS Caddy: web and native-protocol OAuth approval/callback, pending access, verified admin promotion, preapproval before first login, tester revocation, catalog and People passed; legacy redirects drop paths/queries; downloads/install/media/socket/API preserved.'
      )
    } finally {
      if (caddy != null) {
        caddy.kill('SIGTERM')
        await once(caddy, 'exit')
      }
      if (masonServer != null) {
        masonServer.closeAllConnections()
        await new Promise<void>(resolve =>
          masonServer!.close(() => {
            resolve()
          })
        )
      }
      if (tsServer != null) {
        tsServer.closeAllConnections()
        await new Promise<void>(resolve =>
          tsServer!.close(() => {
            resolve()
          })
        )
      }
      if (store != null) store.close()
      if (agent != null) await agent.close()
      if (db != null) await db.destroy()
      await pool.end()
      if (created) await admin.query(`DROP DATABASE "${dbName}"`)
      await admin.end()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
