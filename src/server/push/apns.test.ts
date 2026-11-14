import { generateKeyPairSync, type KeyObject, verify } from 'node:crypto'
import {
  type ClientHttp2Session,
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream
} from 'node:http2'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import {
  APNS_ORIGINS,
  type ApnsMessage,
  apnsTransport,
  PROVIDER_TOKEN_MS,
  providerToken
} from './apns'
import type { PushAddress } from './send'

/** A request the fake APNs heard. */
interface Heard {
  server: 'production' | 'development'
  headers: IncomingHttpHeaders
  body: string
}

/**
 * What the fake answers next, after `delayMs` when given, or `hang` to answer
 * nothing.
 */
type Answer = { status: number; body?: string; delayMs?: number } | 'hang'

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

describe('the APNs transport', function () {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  })
  const settings = {
    keyId: 'ABC123DEFG',
    teamId: 'TEAM123456',
    p8Key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    topic: 'app.example.test'
  }
  const heard: Heard[] = []
  let answers: Answer[] = []
  const servers: Http2Server[] = []
  const origins = { production: '', development: '' }

  const listen = async (name: Heard['server']): Promise<string> => {
    const server = createServer()
    server.on('stream', (stream: ServerHttp2Stream, headers) => {
      let body = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        body += chunk
      })
      stream.on('end', () => {
        heard.push({ server: name, headers, body })
        const answer = answers.shift() ?? { status: 200 }
        if (answer === 'hang') return
        setTimeout(() => {
          if (stream.closed) return
          stream.respond({ ':status': answer.status })
          stream.end(answer.body ?? '')
        }, answer.delayMs ?? 0)
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  before(async () => {
    origins.production = await listen('production')
    origins.development = await listen('development')
  })
  beforeEach(() => {
    heard.length = 0
    answers = []
  })
  after(async () => {
    for (const server of servers)
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
  })

  const device: PushAddress = {
    id: 'psh_one',
    userId: 'usr_one',
    platform: 'ios',
    address: '00ab'.repeat(16),
    environment: 'production'
  }
  const alert: ApnsMessage = {
    platform: 'ios',
    pushType: 'alert',
    priority: 10,
    payload: { aps: { alert: { body: 'New message' }, 'mutable-content': 1 } }
  }
  const verifies = (token: string, key: KeyObject): boolean => {
    const [header, claims, signature] = token.split('.')
    return verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    )
  }

  it('talks to Apple’s own servers unless told otherwise', function () {
    expect(APNS_ORIGINS).deep.equals({
      production: 'https://api.push.apple.com',
      development: 'https://api.sandbox.push.apple.com'
    })
  })

  it('signs a provider token with the key: ES256, kid, team and time', function () {
    const token = providerToken(
      settings,
      privateKey,
      Date.UTC(2026, 10, 12, 8, 0, 30)
    )
    const [header, claims] = token.split('.')
    expect(decode(header)).deep.equals({ alg: 'ES256', kid: 'ABC123DEFG' })
    expect(decode(claims)).deep.equals({
      iss: 'TEAM123456',
      iat: Date.UTC(2026, 10, 12, 8, 0, 30) / 1000
    })
    expect(verifies(token, publicKey)).equals(true)
    // Another key's signature does not pass.
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    expect(verifies(token, other.publicKey)).equals(false)
  })

  it('posts the payload to the device with every header APNs reads', async function () {
    const transport = apnsTransport(settings, { origins })
    const result = await transport.send(device, {
      ...alert,
      collapseId: 'chat:cnv_one',
      expiration: 0
    })
    transport.close()
    expect(result).deep.equals({ status: 'sent' })
    expect(heard).length(1)
    const { headers, body, server } = heard[0]
    expect(server).equals('production')
    expect(headers[':method']).equals('POST')
    expect(headers[':path']).equals(`/3/device/${device.address}`)
    expect(headers['apns-topic']).equals('app.example.test')
    expect(headers['apns-push-type']).equals('alert')
    expect(headers['apns-priority']).equals('10')
    expect(headers['apns-collapse-id']).equals('chat:cnv_one')
    expect(headers['apns-expiration']).equals('0')
    expect(headers['content-type']).equals('application/json')
    expect(JSON.parse(body)).deep.equals(alert.payload)
    const bearer = String(headers.authorization)
    expect(bearer.startsWith('bearer ')).equals(true)
    const token = bearer.slice('bearer '.length)
    expect(verifies(token, publicKey)).equals(true)
    expect(decode(token.split('.')[1]).iss).equals('TEAM123456')
  })

  it('sends a background push with its own type and priority, and no extras', async function () {
    const transport = apnsTransport(settings, { origins })
    await transport.send(device, {
      platform: 'ios',
      pushType: 'background',
      priority: 5,
      payload: { aps: { 'content-available': 1 } }
    })
    transport.close()
    const { headers } = heard[0]
    expect(headers['apns-push-type']).equals('background')
    expect(headers['apns-priority']).equals('5')
    expect(headers['apns-collapse-id']).equals(undefined)
    expect(headers['apns-expiration']).equals(undefined)
  })

  it('sends a development build’s token to the sandbox', async function () {
    const transport = apnsTransport(settings, { origins })
    await transport.send({ ...device, environment: 'development' }, alert)
    await transport.send(device, alert)
    transport.close()
    expect(heard.map(item => item.server)).deep.equals([
      'development',
      'production'
    ])
  })

  it('reuses its token for 50 minutes, then makes a new one', async function () {
    let now = Date.UTC(2026, 10, 12, 8, 0, 0)
    const transport = apnsTransport(settings, { origins, now: () => now })
    await transport.send(device, alert)
    now += PROVIDER_TOKEN_MS - 1000
    await transport.send(device, alert)
    now += 1000
    await transport.send(device, alert)
    transport.close()
    const tokens = heard.map(item => String(item.headers.authorization))
    expect(tokens[1]).equals(tokens[0])
    expect(tokens[2]).not.equals(tokens[0])
    expect(decode(tokens[2].split('.')[1]).iat).equals(
      Date.UTC(2026, 10, 12, 8, 50, 0) / 1000
    )
  })

  it('calls a token gone on 410 or an unregistered device', async function () {
    const transport = apnsTransport(settings, { origins })
    answers = [
      { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) },
      { status: 410 },
      { status: 400, body: JSON.stringify({ reason: 'Unregistered' }) }
    ]
    const results = [
      await transport.send(device, alert),
      await transport.send(device, alert),
      await transport.send(device, alert)
    ]
    transport.close()
    expect(results).deep.equals([
      { status: 'gone', reason: 'Unregistered' },
      { status: 'gone', reason: 'HTTP 410' },
      { status: 'gone', reason: 'Unregistered' }
    ])
  })

  it('keeps a bad device token, naming its environment, since it may be the other environment’s, and never tries it again', async function () {
    const transport = apnsTransport(settings, { origins })
    answers = [
      { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) },
      { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) }
    ]
    const results = [
      await transport.send(device, alert),
      await transport.send({ ...device, environment: 'development' }, alert)
    ]
    transport.close()
    expect(results).deep.equals([
      { status: 'rejected', reason: 'BadDeviceToken for a production token' },
      { status: 'rejected', reason: 'BadDeviceToken for a development token' }
    ])
  })

  it('marks only a token APNs refuses for itself, and refuses for good a message it will not take, the token kept', async function () {
    const transport = apnsTransport(settings, { origins })
    const refusing = [
      'BadTopic',
      'MissingTopic',
      'TopicDisallowed',
      'BadExpirationDate',
      'BadPriority',
      'BadCollapseId',
      'PayloadEmpty',
      'PayloadTooLarge'
    ]
    answers = [
      {
        status: 400,
        body: JSON.stringify({ reason: 'DeviceTokenNotForTopic' })
      },
      ...refusing.map(reason => ({
        status: 400,
        body: JSON.stringify({ reason })
      })),
      { status: 400, body: 'not json' },
      { status: 400, body: JSON.stringify({ reason: 'IdleTimeout' }) },
      { status: 500, body: 'not json' },
      { status: 429, body: 'null' }
    ]
    const results = []
    for (let i = 0; i < refusing.length + 5; i++)
      results.push(await transport.send(device, alert))
    transport.close()
    expect(results).deep.equals([
      { status: 'rejected', reason: 'DeviceTokenNotForTopic' },
      ...refusing.map(reason => ({ status: 'refused', reason })),
      { status: 'refused', reason: 'HTTP 400' },
      // A connection APNs closed for idling: the next try may get through.
      { status: 'failed', reason: 'IdleTimeout' },
      { status: 'failed', reason: 'HTTP 500' },
      { status: 'failed', reason: 'HTTP 429' }
    ])
  })

  it('makes a new provider token once APNs refuses the one it has', async function () {
    let now = Date.UTC(2026, 10, 12, 8, 0, 0)
    const transport = apnsTransport(settings, { origins, now: () => now })
    answers = [
      { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) }
    ]
    expect(await transport.send(device, alert)).deep.equals({
      status: 'failed',
      reason: 'ExpiredProviderToken'
    })
    now += 1000
    await transport.send(device, alert)
    transport.close()
    expect(heard[1].headers.authorization).not.equals(
      heard[0].headers.authorization
    )
  })

  it('answers a failure when APNs cannot be reached or does not answer', async function () {
    const closed = apnsTransport(settings, {
      origins: { production: 'http://127.0.0.1:1', development: '' }
    })
    const unreachable = await closed.send(device, alert)
    closed.close()
    expect(unreachable.status).equals('failed')

    const slow = apnsTransport(settings, { origins, timeoutMs: 50 })
    answers = ['hang']
    const silent = await slow.send(device, alert)
    slow.close()
    expect(silent).deep.equals({
      status: 'failed',
      reason: 'Error: no answer in 50 ms'
    })
  })

  it('drops a connection that left a send unanswered, and the next send opens a new one', async function () {
    const opened: ClientHttp2Session[] = []
    const { connect } = await import('node:http2')
    const transport = apnsTransport(settings, {
      origins,
      timeoutMs: 50,
      connect: origin => {
        const session = connect(origin)
        opened.push(session)
        return session
      }
    })
    answers = ['hang']
    expect(await transport.send(device, alert)).deep.equals({
      status: 'failed',
      reason: 'Error: no answer in 50 ms'
    })
    expect(opened).length(1)
    expect(opened[0].closed).equals(true)
    expect(await transport.send(device, alert)).deep.equals({ status: 'sent' })
    expect(opened).length(2)
    expect(opened[1].closed).equals(false)
    transport.close()
  })

  it('lets the other sends on a connection that left one unanswered finish, and sends nothing more on it', async function () {
    const opened: ClientHttp2Session[] = []
    const { connect } = await import('node:http2')
    const transport = apnsTransport(settings, {
      origins,
      timeoutMs: 400,
      connect: origin => {
        const session = connect(origin)
        opened.push(session)
        return session
      }
    })
    // The first hangs; the second, sent 150 ms later, is answered 100 ms
    // after the first has timed out, and well inside its own time.
    answers = ['hang', { status: 200, delayMs: 350 }]
    const hung = transport.send(device, alert)
    await new Promise(resolve => setTimeout(resolve, 150))
    const answered = transport.send(device, alert)
    expect(await hung).deep.equals({
      status: 'failed',
      reason: 'Error: no answer in 400 ms'
    })
    expect(opened[0].closed).equals(true)
    expect(opened[0].destroyed).equals(false)
    // A send after the timeout goes on a connection of its own.
    expect(await transport.send(device, alert)).deep.equals({ status: 'sent' })
    expect(opened).length(2)
    expect(await answered).deep.equals({ status: 'sent' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(opened[0].destroyed).equals(true)
    transport.close()
  })

  it('keeps one connection open, and opens another once it closes', async function () {
    const opened: string[] = []
    const { connect } = await import('node:http2')
    const transport = apnsTransport(settings, {
      origins,
      connect: origin => {
        opened.push(origin)
        return connect(origin)
      }
    })
    await transport.send(device, alert)
    await transport.send(device, alert)
    expect(opened).length(1)
    transport.close()
    await transport.send(device, alert)
    transport.close()
    expect(opened).length(2)
  })
})
