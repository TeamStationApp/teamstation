import { request } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { asAppLinksConfig } from '../appLinks/config'
import { errorHandler, notFoundHandler } from '../middleware/withErrors'
import { appLinkRoutes } from './appLinks'

const FINGERPRINT = Array(32).fill('AB').join(':')
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456'
const PUBLIC_URL = 'https://gs.example.test'
const SEAT = 'https://seat.example.test'

const appLinks = asAppLinksConfig({
  knownServers: [SEAT],
  apps: [
    {
      origin: 'https://app1.example.test',
      apple: { appIds: ['TEAM000000.test.example.app1'] },
      android: {
        packageName: 'test.example.app1',
        sha256CertFingerprints: [FINGERPRINT]
      }
    },
    {
      origin: 'https://ios-only.example.test',
      apple: { appIds: ['TEAM000000.test.example.ios'] }
    },
    {
      origin: 'https://android-only.example.test',
      android: {
        packageName: 'test.example.android',
        sha256CertFingerprints: [FINGERPRINT]
      }
    }
  ]
})

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

describe('app link hosts', function () {
  let server: ReturnType<express.Express['listen']> | undefined
  let port = 0

  before(async function () {
    const app = express()
    app.use(appLinkRoutes({ appLinks, publicUrl: PUBLIC_URL }))
    app.use(notFoundHandler)
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    port = (server.address() as AddressInfo).port
  })

  after(function () {
    server?.close()
  })

  /** A GET with an explicit `Host`, as the reverse proxy passes it on. */
  async function get(host: string, path: string): Promise<Answer> {
    return await new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, method: 'GET', headers: { host } },
        res => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', chunk => {
            body += chunk
          })
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
          })
        }
      )
      req.on('error', reject)
      req.end()
    })
  }

  describe('apple-app-site-association', function () {
    it('names the host’s iOS app and its sign-in path', async function () {
      const answer = await get(
        'app1.example.test',
        '/.well-known/apple-app-site-association'
      )
      expect(answer.status).equals(200)
      expect(answer.headers['content-type']).match(/^application\/json/)
      expect(answer.headers['cache-control']).equals('public, max-age=3600')
      expect(JSON.parse(answer.body)).deep.equals({
        applinks: {
          details: [
            {
              appIDs: ['TEAM000000.test.example.app1'],
              components: [{ '/': '/signin/*' }]
            }
          ]
        }
      })
    })
    it('is not found for a host with no iOS app, or no app', async function () {
      for (const host of ['android-only.example.test', 'other.example.test']) {
        const answer = await get(
          host,
          '/.well-known/apple-app-site-association'
        )
        expect(answer.status).equals(404)
      }
    })
  })

  describe('assetlinks.json', function () {
    it('names the host’s Android package and its signing keys', async function () {
      const answer = await get(
        'android-only.example.test',
        '/.well-known/assetlinks.json'
      )
      expect(answer.status).equals(200)
      expect(answer.headers['content-type']).match(/^application\/json/)
      expect(JSON.parse(answer.body)).deep.equals([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: 'test.example.android',
            sha256_cert_fingerprints: [FINGERPRINT]
          }
        }
      ])
    })
    it('is not found for a host with no Android app, or no app', async function () {
      for (const host of ['ios-only.example.test', 'other.example.test']) {
        const answer = await get(host, '/.well-known/assetlinks.json')
        expect(answer.status).equals(404)
      }
    })
  })

  describe('/signin/<token>', function () {
    it('sends a browser to this server’s sign-in when no server is named', async function () {
      const answer = await get('app1.example.test', `/signin/${TOKEN}`)
      expect(answer.status).equals(302)
      expect(answer.headers.location).equals(`${PUBLIC_URL}/signin/${TOKEN}`)
      expect(answer.headers['cache-control']).equals('no-store')
      expect(answer.headers['referrer-policy']).equals('no-referrer')
    })
    it('sends it to a server it knows, or to itself by name', async function () {
      for (const server of [SEAT, PUBLIC_URL]) {
        const answer = await get(
          'app1.example.test',
          `/signin/${TOKEN}?server=${encodeURIComponent(server)}`
        )
        expect(answer.status).equals(302)
        expect(answer.headers.location).equals(`${server}/signin/${TOKEN}`)
      }
    })
    it('refuses any other server, a path, or two of them', async function () {
      for (const query of [
        `server=${encodeURIComponent('https://evil.example.test')}`,
        `server=${encodeURIComponent(`${SEAT}/x`)}`,
        `server=${encodeURIComponent(`${SEAT}/`)}`,
        `server=${encodeURIComponent(SEAT)}&server=${encodeURIComponent(SEAT)}`
      ]) {
        const answer = await get(
          'app1.example.test',
          `/signin/${TOKEN}?${query}`
        )
        expect(answer.status).equals(400)
        expect(answer.headers.location).equals(undefined)
        expect(answer.headers['cache-control']).equals('no-store')
      }
    })
    it('refuses something that is not a token', async function () {
      for (const token of [
        'short',
        'has.dots.in.it.0123456789',
        'x'.repeat(200)
      ]) {
        const answer = await get('app1.example.test', `/signin/${token}`)
        expect(answer.status).equals(400)
      }
    })
    it('is not found on a host that is no app’s', async function () {
      const answer = await get('other.example.test', `/signin/${TOKEN}`)
      expect(answer.status).equals(404)
    })
    it('reads the host without regard to case', async function () {
      const answer = await get('APP1.example.test', `/signin/${TOKEN}`)
      expect(answer.status).equals(302)
    })
  })
})
