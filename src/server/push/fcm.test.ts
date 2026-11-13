import { generateKeyPairSync, verify } from 'node:crypto'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  FCM_ORIGIN,
  FCM_SCOPE,
  FCM_TOKEN_URL,
  fcmBody,
  type FcmMessage,
  fcmTransport,
  grantAssertion
} from './fcm'
import type { PushAddress } from './send'

interface Call {
  url: string
  init: RequestInit
}

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/** A fetch that records each call and answers from `answer`. */
function fakeFetch(
  answer: (call: Call, index: number) => Response | Promise<Response>
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const call = { url: input.toString(), init: init ?? {} }
    calls.push(call)
    return await answer(call, calls.length - 1)
  }) as typeof fetch
  return { fetch: fetcher, calls }
}
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
const tokenAnswer = (
  value = 'ya29.token',
  expiresIn: unknown = 3599
): Response =>
  json(200, {
    access_token: value,
    expires_in: expiresIn,
    token_type: 'Bearer'
  })

describe('the FCM transport', function () {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048
  })
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const settings = {
    projectId: 'demo-project',
    clientEmail: 'push@demo-project.iam.example.test',
    privateKey: pem
  }
  const device: PushAddress = {
    id: 'psh_one',
    userId: 'usr_one',
    platform: 'android',
    address: 'fcm-token:APA91b-example_token',
    environment: 'production'
  }
  const wake: FcmMessage = {
    platform: 'android',
    priority: 'high',
    data: { payload: '{"t":"chat"}' }
  }
  /** Token calls answer a token; sends answer `send`. */
  const service = (
    send: (call: Call) => Response = () =>
      json(200, { name: 'projects/x/messages/1' }),
    token: () => Response = () => tokenAnswer()
  ): { fetch: typeof fetch; calls: Call[] } =>
    fakeFetch(call => (call.url === FCM_TOKEN_URL ? token() : send(call)))

  it('talks to Google’s own endpoints unless told otherwise', function () {
    expect(FCM_TOKEN_URL).equals('https://oauth2.googleapis.com/token')
    expect(FCM_ORIGIN).equals('https://fcm.googleapis.com')
    expect(FCM_SCOPE).equals(
      'https://www.googleapis.com/auth/firebase.messaging'
    )
  })

  it('asks for its OAuth token with an RS256 grant the service account signed', async function () {
    const at = Date.UTC(2026, 10, 12, 8, 0, 0)
    const { fetch, calls } = service()
    const transport = fcmTransport(settings, { fetch, now: () => at })
    expect(await transport.send(device, wake)).deep.equals({ status: 'sent' })
    const grant = calls[0]
    expect(grant.url).equals(FCM_TOKEN_URL)
    expect(grant.init.method).equals('POST')
    expect(
      (grant.init.headers as Record<string, string>)['content-type']
    ).equals('application/x-www-form-urlencoded')
    const form = new URLSearchParams(grant.init.body as string)
    expect(form.get('grant_type')).equals(
      'urn:ietf:params:oauth:grant-type:jwt-bearer'
    )
    const assertion = form.get('assertion')!
    const [header, claims, signature] = assertion.split('.')
    expect(decode(header)).deep.equals({ alg: 'RS256', typ: 'JWT' })
    expect(decode(claims)).deep.equals({
      iss: 'push@demo-project.iam.example.test',
      scope: FCM_SCOPE,
      aud: FCM_TOKEN_URL,
      iat: at / 1000,
      exp: at / 1000 + 3600
    })
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, 'base64url')
      )
    ).equals(true)
    expect(grantAssertion(settings, privateKey, at)).equals(assertion)
  })

  it('sends the message to the device as data, at its priority', async function () {
    const { fetch, calls } = service()
    const transport = fcmTransport(settings, { fetch })
    await transport.send(device, wake)
    await transport.send(device, {
      platform: 'android',
      priority: 'normal',
      data: { payload: '{}' },
      ttlSeconds: 600,
      collapseKey: 'chat:cnv_one'
    })
    const [first, second] = calls.slice(1)
    expect(first.url).equals(
      'https://fcm.googleapis.com/v1/projects/demo-project/messages:send'
    )
    expect(first.init.method).equals('POST')
    expect(first.init.headers).deep.equals({
      authorization: 'Bearer ya29.token',
      'content-type': 'application/json'
    })
    expect(JSON.parse(first.init.body as string)).deep.equals({
      message: {
        token: device.address,
        data: { payload: '{"t":"chat"}' },
        android: { priority: 'HIGH' }
      }
    })
    expect(JSON.parse(second.init.body as string)).deep.equals({
      message: {
        token: device.address,
        data: { payload: '{}' },
        android: {
          priority: 'NORMAL',
          ttl: '600s',
          collapseKey: 'chat:cnv_one'
        }
      }
    })
    expect(fcmBody('t', wake)).deep.equals({
      message: { token: 't', data: wake.data, android: { priority: 'HIGH' } }
    })
  })

  it('shares one token between sends, until a minute before it expires', async function () {
    let now = Date.UTC(2026, 10, 12, 8, 0, 0)
    let issued = 0
    const { fetch, calls } = service(undefined, () =>
      tokenAnswer(`ya29.${++issued}`, 3600)
    )
    const transport = fcmTransport(settings, { fetch, now: () => now })
    await Promise.all([
      transport.send(device, wake),
      transport.send(device, wake),
      transport.send(device, wake)
    ])
    now += 59 * 60_000 - 1
    await transport.send(device, wake)
    now += 1
    await transport.send(device, wake)
    const grants = calls.filter(call => call.url === FCM_TOKEN_URL)
    expect(grants).length(2)
    const used = calls
      .filter(call => call.url !== FCM_TOKEN_URL)
      .map(call => (call.init.headers as Record<string, string>).authorization)
    expect(used).deep.equals([
      'Bearer ya29.1',
      'Bearer ya29.1',
      'Bearer ya29.1',
      'Bearer ya29.1',
      'Bearer ya29.2'
    ])
  })

  it('calls only an unregistered token gone, never a bare 404 or a missing project', async function () {
    const unregistered = {
      error: {
        code: 404,
        status: 'NOT_FOUND',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo' },
          {
            '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
            errorCode: 'UNREGISTERED'
          }
        ]
      }
    }
    const answers = [
      json(400, {
        error: {
          status: 'INVALID_ARGUMENT',
          details: [{ errorCode: 'UNREGISTERED' }]
        }
      }),
      json(404, unregistered),
      new Response('', { status: 404 }),
      json(404, {
        error: {
          code: 404,
          status: 'NOT_FOUND',
          message: 'Requested entity was not found.'
        }
      })
    ]
    const { fetch } = service(() => answers.shift()!)
    const transport = fcmTransport(settings, { fetch })
    expect([
      await transport.send(device, wake),
      await transport.send(device, wake),
      await transport.send(device, wake),
      await transport.send(device, wake)
    ]).deep.equals([
      { status: 'gone', reason: 'UNREGISTERED' },
      { status: 'gone', reason: 'UNREGISTERED' },
      { status: 'failed', reason: 'HTTP 404' },
      { status: 'failed', reason: 'NOT_FOUND' }
    ])
  })

  it('keeps the token on any other refusal, never tries one FCM refuses for good, and fetches a new token after a 401', async function () {
    let issued = 0
    const answers = [
      // FCM's answer to a token it cannot read: the field it names.
      json(400, {
        error: {
          code: 400,
          message:
            'The registration token is not a valid FCM registration token',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'INVALID_ARGUMENT'
            },
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [
                {
                  field: 'message.token',
                  description: 'Invalid registration token'
                }
              ]
            }
          ]
        }
      }),
      json(403, {
        error: {
          status: 'PERMISSION_DENIED',
          details: [{ errorCode: 'SENDER_ID_MISMATCH' }]
        }
      }),
      new Response('busy', { status: 503 }),
      json(401, { error: { status: 'UNAUTHENTICATED', details: [{}] } }),
      json(200, {})
    ]
    const { fetch, calls } = service(
      () => answers.shift()!,
      () => tokenAnswer(`ya29.${++issued}`)
    )
    const transport = fcmTransport(settings, { fetch })
    expect([
      await transport.send(device, wake),
      await transport.send(device, wake),
      await transport.send(device, wake),
      await transport.send(device, wake),
      await transport.send(device, wake)
    ]).deep.equals([
      { status: 'rejected', reason: 'INVALID_ARGUMENT' },
      { status: 'rejected', reason: 'SENDER_ID_MISMATCH' },
      { status: 'failed', reason: 'HTTP 503' },
      { status: 'failed', reason: 'UNAUTHENTICATED' },
      { status: 'sent' }
    ])
    expect(calls.filter(call => call.url === FCM_TOKEN_URL)).length(2)
  })

  it('refuses for good a message FCM will not take, without marking its token', async function () {
    const answers = [
      json(400, { error: { status: 'INVALID_ARGUMENT' } }),
      // A field of the message, not its token.
      json(400, {
        error: {
          status: 'INVALID_ARGUMENT',
          details: [
            { errorCode: 'INVALID_ARGUMENT' },
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [{ field: 'message.android.ttl' }]
            }
          ]
        }
      }),
      json(400, {
        error: {
          status: 'INVALID_ARGUMENT',
          details: [null, { fieldViolations: 'x' }]
        }
      })
    ]
    const { fetch } = service(() => answers.shift()!)
    const transport = fcmTransport(settings, { fetch })
    expect([
      await transport.send(device, wake),
      await transport.send(device, wake),
      await transport.send(device, wake)
    ]).deep.equals([
      { status: 'refused', reason: 'INVALID_ARGUMENT' },
      { status: 'refused', reason: 'INVALID_ARGUMENT' },
      { status: 'refused', reason: 'INVALID_ARGUMENT' }
    ])
  })

  it('answers a failure when no token can be had or nothing answers', async function () {
    const refused = fcmTransport(settings, {
      fetch: service(undefined, () => json(400, { error: 'invalid_grant' }))
        .fetch
    })
    expect(await refused.send(device, wake)).deep.equals({
      status: 'failed',
      reason: 'Error: the token endpoint answered HTTP 400'
    })
    const empty = fcmTransport(settings, {
      fetch: service(undefined, () => json(200, { expires_in: 'soon' })).fetch
    })
    expect(await empty.send(device, wake)).deep.equals({
      status: 'failed',
      reason: 'Error: the token endpoint sent no access token'
    })
    const offline = fcmTransport(settings, {
      fetch: fakeFetch(() => {
        throw new TypeError('fetch failed')
      }).fetch
    })
    expect(await offline.send(device, wake)).deep.equals({
      status: 'failed',
      reason: 'TypeError: fetch failed'
    })
  })

  it('gives up on a token endpoint or a send that stalls, after the timeout', async function () {
    /** Never answers, until the call's signal gives up on it. */
    const stall = async (call: Call): Promise<Response> =>
      await new Promise((_resolve, reject) => {
        const signal = call.init.signal!
        signal.addEventListener('abort', () => {
          reject(signal.reason)
        })
      })
    const stalledToken = fcmTransport(settings, {
      fetch: fakeFetch(async call =>
        call.url === FCM_TOKEN_URL ? await stall(call) : json(200, {})
      ).fetch,
      timeoutMs: 20
    })
    const tokenResult = await stalledToken.send(device, wake)
    expect(tokenResult.status).equals('failed')
    expect(tokenResult)
      .property('reason')
      .match(/TimeoutError/)
    const { fetch, calls } = fakeFetch(async call =>
      call.url === FCM_TOKEN_URL ? tokenAnswer() : await stall(call)
    )
    const stalledSend = fcmTransport(settings, { fetch, timeoutMs: 20 })
    const sendResult = await stalledSend.send(device, wake)
    expect(sendResult.status).equals('failed')
    expect(sendResult)
      .property('reason')
      .match(/TimeoutError/)
    expect(calls.map(call => call.init.signal)).satisfies(
      (signals: unknown[]) => signals.every(item => item instanceof AbortSignal)
    )
  })

  it('takes a token of any lifetime, and a key whose newlines were escaped', async function () {
    let now = 0
    const { fetch, calls } = service(undefined, () =>
      json(200, { access_token: 'ya29.forever' })
    )
    const transport = fcmTransport(
      { ...settings, privateKey: pem.replace(/\n/g, '\\n') },
      { fetch, now: () => now, origin: 'http://127.0.0.1:9' }
    )
    await transport.send(device, wake)
    now += 3539 * 1000
    await transport.send(device, wake)
    expect(calls.filter(call => call.url === FCM_TOKEN_URL)).length(1)
    expect(calls[1].url).equals(
      'http://127.0.0.1:9/v1/projects/demo-project/messages:send'
    )
  })
})
