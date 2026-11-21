import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify
} from 'node:crypto'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { generateVAPIDKeys } from 'web-push'

import type { PushAddress } from './send'
import { type WebPushMessage, webPushTransport } from './webPush'

interface Call {
  url: string
  init: RequestInit
}

/** The browser's side of a subscription: its key pair and auth secret. */
function browser(endpoint: string): {
  address: string
  decrypt: (body: Uint8Array) => string
} {
  const ecdh = createECDH('prime256v1')
  const ownPublic = ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    address: JSON.stringify({
      endpoint,
      keys: {
        p256dh: ownPublic.toString('base64url'),
        auth: auth.toString('base64url')
      }
    }),
    // RFC 8291 and RFC 8188, as a browser opens a push message.
    decrypt(raw) {
      const body = Buffer.from(raw)
      const salt = body.subarray(0, 16)
      const idLength = body[20]
      const senderPublic = body.subarray(21, 21 + idLength)
      const sealed = body.subarray(21 + idLength)
      const shared = ecdh.computeSecret(senderPublic)
      const ikm = Buffer.from(
        hkdfSync(
          'sha256',
          shared,
          auth,
          Buffer.concat([
            Buffer.from('WebPush: info\0'),
            ownPublic,
            senderPublic
          ]),
          32
        )
      )
      const key = Buffer.from(
        hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16)
      )
      const nonce = Buffer.from(
        hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12)
      )
      const decipher = createDecipheriv('aes-128-gcm', key, nonce)
      decipher.setAuthTag(sealed.subarray(sealed.length - 16))
      const plain = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final()
      ])
      // The last record ends with the 0x02 delimiter, then any padding.
      const end = plain.lastIndexOf(2)
      return plain.subarray(0, end).toString('utf8')
    }
  }
}

function fakeFetch(answer: () => Response): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: input.toString(), init: init ?? {} })
    return answer()
  }) as typeof fetch
  return { fetch: fetcher, calls }
}

describe('the Web Push transport', function () {
  const vapid = generateVAPIDKeys()
  const settings = { ...vapid, subject: 'mailto:push@example.test' }
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def'
  const message: WebPushMessage = {
    platform: 'web',
    payload: JSON.stringify({ t: 'chat', u: 'usr_one', c: 'cnv_one' }),
    urgency: 'high',
    topic: 'chat-cnv_one'
  }
  const device = (address: string): PushAddress => ({
    id: 'psh_one',
    userId: 'usr_one',
    platform: 'web',
    address,
    environment: 'production'
  })

  it('signs a VAPID header and encrypts the payload to the subscription', async function () {
    const subscriber = browser(endpoint)
    const { fetch, calls } = fakeFetch(() => new Response('', { status: 201 }))
    const transport = webPushTransport(settings, { fetch })
    expect(
      await transport.send(device(subscriber.address), message)
    ).deep.equals({ status: 'sent' })
    expect(calls).length(1)
    const { url, init } = calls[0]
    expect(url).equals(endpoint)
    expect(init.method).equals('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Encoding']).equals('aes128gcm')
    expect(headers['Content-Type']).equals('application/octet-stream')
    expect(headers.TTL).equals(String(24 * 60 * 60))
    expect(headers.Urgency).equals('high')
    expect(headers.Topic).equals('chat-cnv_one')
    expect(Object.keys(headers).map(name => name.toLowerCase())).not.includes(
      'content-length'
    )

    // `vapid t=<jwt>, k=<the server's public key>`.
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization)
    expect(match, headers.Authorization).not.equals(null)
    const [, jwt, k] = match!
    expect(k).equals(vapid.publicKey)
    const [header, claims, signature] = jwt.split('.')
    const decode = (part: string): Record<string, unknown> =>
      JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    expect(decode(header)).deep.equals({ typ: 'JWT', alg: 'ES256' })
    const claimed = decode(claims)
    expect(claimed.aud).equals('https://fcm.googleapis.com')
    expect(claimed.sub).equals('mailto:push@example.test')
    expect(Number(claimed.exp)).greaterThan(Date.now() / 1000)
    const raw = Buffer.from(vapid.publicKey, 'base64url')
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33, 65).toString('base64url')
      },
      format: 'jwk'
    })
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url')
      )
    ).equals(true)

    expect(subscriber.decrypt(init.body as Uint8Array)).equals(message.payload)
  })

  it('leaves urgency and topic to the service when the message has none', async function () {
    const subscriber = browser(endpoint)
    const { fetch, calls } = fakeFetch(() => new Response('', { status: 201 }))
    await webPushTransport(settings, { fetch }).send(
      device(subscriber.address),
      {
        platform: 'web',
        payload: 'reminder',
        ttlSeconds: 60
      }
    )
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.TTL).equals('60')
    expect(headers.Topic).equals(undefined)
    expect(subscriber.decrypt(calls[0].init.body as Uint8Array)).equals(
      'reminder'
    )
  })

  it('calls a subscription gone on 404 or 410, refused for good on 400 or 403, and fails on anything else, reading no answer', async function () {
    const subscriber = browser(endpoint)
    const results = []
    const answers: Response[] = []
    for (const status of [201, 404, 410, 400, 403, 413, 500]) {
      const { fetch } = fakeFetch(() => {
        const answer = new Response('the service says why', { status })
        answers.push(answer)
        return answer
      })
      results.push(
        await webPushTransport(settings, { fetch }).send(
          device(subscriber.address),
          message
        )
      )
    }
    expect(results).deep.equals([
      { status: 'sent' },
      { status: 'gone', reason: 'HTTP 404' },
      { status: 'gone', reason: 'HTTP 410' },
      { status: 'rejected', reason: 'HTTP 400' },
      { status: 'rejected', reason: 'HTTP 403' },
      { status: 'failed', reason: 'HTTP 413' },
      { status: 'failed', reason: 'HTTP 500' }
    ])
    // Each answer was let go, its connection with it.
    expect(answers.map(answer => answer.bodyUsed)).deep.equals(
      answers.map(() => true)
    )
  })

  it('answers a failure for an unreadable subscription or an unreachable service', async function () {
    const { fetch, calls } = fakeFetch(() => new Response('', { status: 201 }))
    const broken = await webPushTransport(settings, { fetch }).send(
      device('not json'),
      message
    )
    expect(broken.status).equals('failed')
    expect(calls).length(0)
    const offline = await webPushTransport(settings, {
      fetch: async () => {
        throw new TypeError('fetch failed')
      }
    }).send(device(browser(endpoint).address), message)
    expect(offline).deep.equals({
      status: 'failed',
      reason: 'TypeError: fetch failed'
    })
  })
  it('gives up on a push service that stalls, after the timeout', async function () {
    const calls: Call[] = []
    const stalled = webPushTransport(settings, {
      fetch: (async (input: string | URL, init?: RequestInit) => {
        calls.push({ url: input.toString(), init: init ?? {} })
        // Never answers, until the call's signal gives up on it.
        return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => {
            reject(init!.signal!.reason)
          })
        })
      }) as typeof fetch,
      timeoutMs: 20
    })
    const result = await stalled.send(
      device(browser(endpoint).address),
      message
    )
    expect(result.status).equals('failed')
    expect(result)
      .property('reason')
      .match(/TimeoutError/)
    expect(calls).length(1)
    expect(calls[0].init.signal).instanceOf(AbortSignal)
  })
})
