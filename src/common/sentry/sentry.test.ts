import type { Event } from '@sentry/core'
import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../errors'
import { hostOfUrl, sentryEnvironment } from './environment'
import { isExplained } from './filter'
import { sentryRelease } from './release'
import {
  DATA_COLLECTION,
  FILTERED,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubValue
} from './scrub'

describe('sentry scrub', function () {
  const texts: Array<[string, string]> = [
    [
      'https://app.example.test/signin/abc123',
      `https://app.example.test/signin/${FILTERED}`
    ],
    ['/i/INVITE42?ref=x', `/i/${FILTERED}`],
    [
      'https://app.example.test/c/invite/INVITE42',
      `https://app.example.test/c/invite/${FILTERED}`
    ],
    [
      'GET /api/v1/oauth/approvals/h4ndleAbc_-123',
      `GET /api/v1/oauth/approvals/${FILTERED}`
    ],
    [
      'teamstation:///oauth/native-approval/h4ndleAbc_-123',
      `teamstation:///oauth/native-approval/${FILTERED}`
    ],
    [
      "undefined is not a function (evaluating 'a?.b()')",
      "undefined is not a function (evaluating 'a?.b()')"
    ],
    ["Unexpected token '?'", "Unexpected token '?'"],
    [
      'POST /api/v1/join/INVITE42/redeem',
      `POST /api/v1/join/${FILTERED}/redeem`
    ],
    [
      '/media/1700000000/sig_abc/videos/9/hls/x.m3u8',
      `/media/${FILTERED}/videos/9/hls/x.m3u8`
    ],
    [
      'rtmps://live.example.test:1936/live/streamkey123',
      `rtmps://live.example.test:1936/live/${FILTERED}`
    ],
    [
      'rtmp://live.example.test/streamkey123',
      `rtmp://live.example.test/${FILTERED}`
    ],
    ['/api/v1/teams?token', '/api/v1/teams'],
    ['/api/v1/teams?token=abc&x=1', '/api/v1/teams'],
    [
      'sign-in code for ruth@example.test: 123456',
      'sign-in code for [email]: 123456'
    ],
    ['Why did it fail?', 'Why did it fail?'],
    ['/api/v1/teams/7/games', '/api/v1/teams/7/games']
  ]
  for (const [input, output] of texts) {
    it(`filters ${input}`, function () {
      expect(scrubText(input)).equals(output)
    })
  }

  it('filters secret-named keys at any depth and leaves the rest', function () {
    expect(
      scrubValue({
        a: { b: { clientHash: 'h', code: '123456', nested: [{ token: 't' }] } },
        streamKey: 'k',
        email: 'e',
        sessionId: 's',
        bearer: 'b',
        api_key: 'a',
        privateKey: 'p',
        credentials: 'c',
        csrfToken: 'x',
        status_code: 500,
        'http.response.status_code': 500,
        errorCode: 'E_FAIL',
        exit_code: 1,
        count: 3,
        ok: true,
        none: null,
        link: '/signin/abc'
      })
    ).deep.equals({
      a: {
        b: {
          clientHash: FILTERED,
          code: FILTERED,
          nested: [{ token: FILTERED }]
        }
      },
      streamKey: FILTERED,
      email: FILTERED,
      sessionId: FILTERED,
      bearer: FILTERED,
      api_key: FILTERED,
      privateKey: FILTERED,
      credentials: FILTERED,
      csrfToken: FILTERED,
      status_code: 500,
      'http.response.status_code': 500,
      errorCode: 'E_FAIL',
      exit_code: 1,
      count: 3,
      ok: true,
      none: null,
      link: `/signin/${FILTERED}`
    })
  })

  it('stops descending past a depth limit', function () {
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 12; i++) deep = { next: deep }
    expect(JSON.stringify(scrubValue(deep))).contains(FILTERED)
  })

  it('drops console breadcrumbs and filters the rest', function () {
    expect(
      scrubBreadcrumb({ category: 'console', message: 'code 123456' })
    ).equals(null)
    expect(
      scrubBreadcrumb({
        category: 'fetch',
        message: 'POST /signin/abc',
        data: {
          method: 'POST',
          url: '/api/v1/auth/email-code/verify?code=123456',
          status_code: 400
        }
      })
    ).deep.equals({
      category: 'fetch',
      message: `POST /signin/${FILTERED}`,
      data: {
        method: 'POST',
        url: '/api/v1/auth/email-code/verify',
        status_code: 400
      }
    })
    expect(scrubBreadcrumb({ category: 'navigation' })).deep.equals({
      category: 'navigation'
    })
  })

  it('keeps a request to its method, path and harmless headers', function () {
    const event: Event = {
      message: 'failed for ruth@example.test',
      transaction: 'POST /api/v1/join/INVITE42/redeem',
      exception: {
        values: [{ type: 'Error', value: 'GET /i/abc' }, { type: 'Error' }]
      },
      request: {
        method: 'POST',
        url: 'https://app.example.test/api/v1/auth/password?x=1',
        headers: {
          Authorization: 'Bearer t',
          Cookie: 'ts_session=s',
          'X-OAuth-CSRF': 'c',
          'X-Api-Key': 'k',
          'User-Agent': 'ua'
        },
        data: { clientHash: 'h' },
        cookies: { ts_session: 's' },
        query_string: 'x=1'
      },
      server_name: 'workstation.example.test',
      user: { id: '7', email: 'ruth@example.test', ip_address: '192.0.2.1' },
      extra: { token: 't' },
      contexts: { app: { password: 'p', name: 'TeamStation' } },
      breadcrumbs: [
        { category: 'console', message: 'code' },
        { category: 'ui.click', message: 'tap' }
      ]
    }
    expect(scrubEvent(event)).deep.equals({
      message: 'failed for [email]',
      transaction: `POST /api/v1/join/${FILTERED}/redeem`,
      exception: {
        values: [
          { type: 'Error', value: `GET /i/${FILTERED}` },
          { type: 'Error' }
        ]
      },
      request: {
        method: 'POST',
        url: 'https://app.example.test/api/v1/auth/password',
        headers: { 'User-Agent': 'ua' }
      },
      server_name: undefined,
      user: { id: '7' },
      extra: { token: FILTERED },
      contexts: { app: { password: FILTERED, name: 'TeamStation' } },
      breadcrumbs: [{ category: 'ui.click', message: 'tap' }]
    })
  })

  it('drops a user without an id and leaves a bare event alone', function () {
    expect(scrubEvent({ user: { email: 'ruth@example.test' } })).deep.equals({
      user: undefined
    })
    expect(scrubEvent({ request: { method: 'GET' } })).deep.equals({
      request: { method: 'GET', url: undefined, headers: undefined }
    })
    expect(scrubEvent({})).deep.equals({})
  })
})

describe('sentry data collection', function () {
  it('gathers no user fields, cookies, bodies or query strings', function () {
    expect(DATA_COLLECTION).deep.equals({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false
    })
  })
})

describe('sentry release', function () {
  it('names the version and build, and sends the build as dist', function () {
    expect(sentryRelease('app.teamstation.app', '1.0', '1.0.42')).deep.equals({
      release: 'app.teamstation.app@1.0+1.0.42',
      dist: '1.0.42'
    })
    expect(
      sentryRelease('app.teamstation.app', '0.1.0', 'development')
    ).deep.equals({
      release: 'app.teamstation.app@0.1.0+development',
      dist: 'development'
    })
  })
  it('names the version alone without a build', function () {
    expect(
      sentryRelease('app.teamstation.web', '0.1.0-20261008-1200-abc1234')
    ).deep.equals({
      release: 'app.teamstation.web@0.1.0-20261008-1200-abc1234'
    })
    expect(sentryRelease('teamstation-server', 'development', '')).deep.equals({
      release: 'teamstation-server@development'
    })
    expect(sentryRelease('x', '1', '—')).deep.equals({ release: 'x@1' })
  })
})

describe('sentry environment', function () {
  const cases: Array<[string | undefined, string]> = [
    ['app.teamstation.app', 'production'],
    ['APP.teamstation.app:443', 'production'],
    ['develop3.example.test', 'develop3'],
    ['localhost', 'development'],
    ['localhost:9100', 'development'],
    ['127.0.0.1', 'development'],
    ['192.168.1.20:9100', 'development'],
    ['[::1]', 'development'],
    ['host.local', 'development'],
    ['', 'development'],
    [undefined, 'development']
  ]
  for (const [host, environment] of cases) {
    it(`${String(host)} is ${environment}`, function () {
      expect(sentryEnvironment(host)).equals(environment)
    })
  }
  it('reads the host of a URL or authority', function () {
    expect(hostOfUrl('https://develop2.example.test/api/v1')).equals(
      'develop2.example.test'
    )
    expect(hostOfUrl('http://192.168.1.20:9100/api/v1')).equals('192.168.1.20')
    expect(hostOfUrl('app.teamstation.app')).equals('app.teamstation.app')
    expect(hostOfUrl('http://[::1]:9100/')).equals('[::1]')
    expect(hostOfUrl('')).equals(undefined)
    expect(hostOfUrl(undefined)).equals(undefined)
  })
})

describe('sentry filter', function () {
  it('drops what the screen already explains', function () {
    expect(
      isExplained({}, { originalException: new HttpError('offline', 'x') })
    ).equals(true)
    expect(
      isExplained({}, { originalException: new HttpError('notFound', 'x') })
    ).equals(true)
    expect(
      isExplained({ exception: { values: [{ type: 'HttpError' }] } }, undefined)
    ).equals(true)
  })
  it('keeps everything else', function () {
    expect(isExplained({}, { originalException: new TypeError('x') })).equals(
      false
    )
    expect(
      isExplained({ exception: { values: [{ type: 'TypeError' }] } }, {})
    ).equals(false)
    expect(isExplained({}, { originalException: 'a string' })).equals(false)
    // An unplanned error wrapping an HttpError is reported.
    const wrapped = new Error('could not save', {
      cause: new HttpError('notFound', 'x')
    })
    expect(isExplained({}, { originalException: wrapped })).equals(false)
    expect(
      isExplained(
        { exception: { values: [{ type: 'HttpError' }, { type: 'Error' }] } },
        undefined
      )
    ).equals(false)
    expect(isExplained({}, undefined)).equals(false)
  })
})
