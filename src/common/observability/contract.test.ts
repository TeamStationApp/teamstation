import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  APPS,
  bytes,
  EVENT_RULES,
  type EventName,
  jsonLine,
  MAX_AGE_MS,
  MAX_EVENT_BYTES,
  parseBatch,
  parseEvent,
  PROPERTY_TYPES,
  REQUEST_ROUTES,
  SERVER_EVENTS,
  userId
} from './contract'

export const NOW = Date.parse('2026-01-01T12:00:00.000Z')
export const UUID = '00000000-0000-4000-8000-000000000001'
export function sample(
  E: EventName = 'session_started',
  P: Record<string, unknown> = {}
): {
  D: string
  A: 'TS'
  I: string
  E: EventName
  L: 'info'
  R: 1
  P: Record<string, unknown>
} {
  return {
    D: new Date(NOW).toISOString(),
    A: 'TS' as const,
    I: UUID,
    E,
    L: 'info' as const,
    R: 1 as const,
    P
  }
}

describe('private compact event contract', () => {
  it('accepts opaque SDK event identifiers without relaxing session identifiers', () => {
    const I = '00000000-0000-0000-0000-000000000001'
    expect(parseEvent({ ...sample(), I }, NOW).I).equals(I)
    expect(() => parseEvent({ ...sample(), S: I }, NOW)).throws()
    expect(() => parseEvent({ ...sample(), I: I + 'x' }, NOW)).throws()
  })
  it('serializes D first and exactly one JSON object per line for every app/event', () => {
    for (const A of APPS)
      for (const E of Object.keys(EVENT_RULES) as EventName[]) {
        const P =
          E.startsWith('video_') || E === 'watch_progress'
            ? { vi: 'vid_demo', ps: UUID, ms: 1 }
            : E.startsWith('playback_') && E !== 'playback_fetch'
              ? { ps: UUID }
              : {}
        const event = parseEvent(
          { ...sample(E, P), A, V: '1.2.3+4', S: UUID },
          NOW
        )
        const line = jsonLine(event, NOW)
        expect(line.startsWith('{"D":')).equals(true)
        expect(line.split('\n')).length(2)
        expect(bytes(line)).lessThan(MAX_EVENT_BYTES)
        expect(parseBatch(line, NOW)).deep.equals([event])
      }
  })
  it('accepts only the documented typed properties', () => {
    const rows = [
      sample('page_viewed', { pg: 'home', ms: 0 }),
      sample('login_failed', { mt: 'password', sp: 'code', ec: 'invalid' }),
      sample('follow_changed', { id: 'tem_demo', ty: 'team', ok: true }),
      sample('watch_progress', {
        vi: 'vid_demo',
        ps: UUID,
        ms: 15000,
        pos: 10,
        dur: 100,
        rt: -1,
        bytes: 100,
        ec: 'offline'
      }),
      sample('request_completed', {
        op: 'request',
        status: 200,
        ms: 12,
        n: 2,
        on: false
      }),
      sample('search_submitted', { n: 0 })
    ]
    for (const row of rows) expect(parseEvent(row, NOW)).deep.equals(row)
    expect(
      parseEvent(Object.assign(Object.create(null), sample()), NOW).E
    ).equals('session_started')
  })
  it('rejects secret/chat canaries, unknown fields and unsafe primitive shapes', () => {
    const canary = 'private chat text canary@example.test?token=secret'
    const bad = [
      null,
      [],
      new Date(),
      { ...sample(), U: 'usr_other' },
      { ...sample(), N: 'production' },
      { ...sample(), P: { chat: canary } },
      sample('login_failed', { mt: canary }),
      sample('page_viewed', { pg: '/chat/secret' }),
      sample('app_error', { message: canary }),
      sample('group_viewed', { id: canary }),
      sample('group_viewed', { id: 3 }),
      sample('recording_started', { vi: 'gam_demo' }),
      sample('recording_started', { vi: 3 }),
      sample('follow_changed', { ok: 'true' }),
      sample('offline_changed', { on: {} }),
      sample('search_submitted', { n: NaN }),
      sample('search_submitted', { n: Infinity }),
      sample('search_submitted', { n: -1 }),
      sample('search_submitted', { n: 1000001 }),
      sample('api_failed', { status: 99 }),
      sample('api_failed', { status: 600 }),
      sample('session_started', { __proto__: { secret: canary } }),
      { ...sample(), E: '__proto__' },
      { ...sample(), E: 'chat_sent' },
      { ...sample(), E: null },
      { ...sample(), A: 'unknown' },
      { ...sample(), I: canary },
      { ...sample(), L: 'notice' },
      { ...sample(), R: 2 },
      { ...sample(), P: [] },
      { ...sample(), P: null },
      { ...sample(), V: canary },
      { ...sample(), V: 1 },
      { ...sample(), S: canary },
      sample('video_started'),
      sample('watch_progress', { vi: 'vid_demo', ps: UUID })
    ]
    for (const row of bad) expect(() => parseEvent(row, NOW)).throws()
  })
  it('enforces canonical UTC dates and skew/age limits', () => {
    for (const D of [
      null,
      'no',
      '2026-01-01T12:00:00Z',
      '2026-02-30T12:00:00.000Z',
      '9999-99-99T99:99:99.999Z',
      new Date(NOW - MAX_AGE_MS - 1).toISOString(),
      new Date(NOW + 300001).toISOString()
    ])
      expect(() => parseEvent({ ...sample(), D }, NOW)).throws()
    for (const at of [NOW - MAX_AGE_MS, NOW + 300000])
      expect(
        parseEvent({ ...sample(), D: new Date(at).toISOString() }, NOW).D
      ).equals(new Date(at).toISOString())
    expect(parseEvent({ ...sample(), D: new Date().toISOString() }).E).equals(
      'session_started'
    )
  })
  it('limits batches and counts UTF-8 on all platforms', () => {
    expect(bytes('aé漢😀')).equals(Buffer.byteLength('aé漢😀'))
    expect(bytes('\ud800')).equals(3)
    for (const text of [
      '',
      ' ',
      'x'.repeat(65537),
      '{}\n'.repeat(51),
      'bad json'
    ])
      expect(() => parseBatch(text, NOW)).throws()
    const live = { ...sample(), D: new Date().toISOString() }
    expect(parseBatch(jsonLine(parseEvent(live)))).length(1)
  })
  it('accepts only internal account identifiers outside the wire envelope', () => {
    for (const value of ['123', 'usr_demo']) expect(userId(value)).equals(value)
    for (const value of [null, 3, '', '0', 'me@example.test', '123/secret'])
      expect(userId(value)).equals(undefined)
    expect(
      parseEvent({ ...sample(), A: 'TS srv', U: 'usr_demo' }, NOW).U
    ).equals('usr_demo')
    for (const U of ['private-canary', 123, null])
      expect(() => parseEvent({ ...sample(), A: 'TS srv', U }, NOW)).throws()
    expect(() => parseEvent({ ...sample(), U: 'usr_demo' }, NOW)).throws()
  })
  it('accepts tess_request with its tokens, refuses anything else, and keeps it a server event', () => {
    const rows = [
      sample('tess_request', {
        op: 'assistant',
        status: 200,
        ms: 2400,
        it: 9520,
        ot: 75,
        cr: 400,
        cw: 9000
      }),
      sample('tess_request', {
        op: 'assistant',
        status: 529,
        ms: 300,
        ec: 'internal'
      }),
      sample('tess_request', { op: 'assistant', ms: 120000, ec: 'timeout' }),
      sample('tess_request', { it: 10000000, ot: 0 })
    ]
    for (const row of rows)
      expect(parseEvent({ ...row, A: 'TS srv' }, NOW)).deep.equals({
        ...row,
        A: 'TS srv'
      })
    const canary = 'Where is our schedule? private-canary'
    for (const P of [
      { op: 'assistant', text: canary },
      { op: 'assistant', model: 'claude-sonnet-5-5' },
      { op: 'chat' },
      { it: -1 },
      { it: 10000001 },
      { cr: -1 },
      { cr: 10000001 },
      { cw: 'many' },
      { ot: 'many' },
      { ot: NaN },
      { status: 99 },
      { ec: canary }
    ])
      expect(() => parseEvent(sample('tess_request', P), NOW)).throws()
    expect(SERVER_EVENTS.has('tess_request')).equals(true)
    expect(REQUEST_ROUTES).includes('/me/tess/messages')
    expect(
      parseEvent(
        sample('request_completed', { op: 'request', rp: '/me/tess/messages' }),
        NOW
      ).P.rp
    ).equals('/me/tess/messages')
  })
})

describe('playback telemetry contract', () => {
  const session = {
    vi: 'vid_demoLive0001',
    ps: UUID,
    en: 'avplayer',
    sf: 'card',
    lv: true
  }
  it('accepts a whole attachment story', () => {
    const story: Array<[EventName, Record<string, unknown>]> = [
      ['playback_attached', { si: 'live_edge', pos: 0 }],
      ['playback_source_set', { ms: 3 }],
      ['playback_metadata', { ms: 900, wd: 1920, ht: 1080, n: 1 }],
      ['playback_canplay', { ms: 1400 }],
      [
        'playback_first_frame',
        { ms: 2100, pms: 28000, rl: 0, pr: false, pos: 600, be: 45, ba: 12.5 }
      ],
      ['playback_stall_started', { sr: 'waiting', pos: 640, be: 2, td: 6 }],
      ['playback_stall_ended', { ms: 1000, pos: 640.2, be: 2.4 }],
      [
        'playback_seek',
        { sk: 'jump_to_present', fr: 640, to: 700, bb: 50, bf: -0.5 }
      ],
      [
        'playback_error',
        { ek: 'hls_network', ed: 'frag_load_error', cd: -12660, ft: true }
      ],
      ['playback_recovery', { rk: 'stall_reload', n: 2 }],
      [
        'playback_heartbeat',
        { rt: 1, bw: 8e6, br: 4.3e6, df: 3, tf: 9000, pl: true, wms: 30000 }
      ],
      ['playback_bitrate', { br: 4.3e6 }],
      ['playback_detached', { ms: 90000, wms: 80000, sc: 3, sms: 3000, rl: 1 }]
    ]
    for (const [E, P] of story)
      expect(parseEvent(sample(E, { ...session, ...P }), NOW).P).deep.equals({
        ...session,
        ...P
      })
  })
  it('needs the attachment session on every playback event but a fetch', () => {
    expect(() =>
      parseEvent(sample('playback_heartbeat', { vi: session.vi }), NOW)
    ).throws('Playback session required')
    const fetch = {
      fk: 'live_now',
      sf: 'card',
      oc: 'pending',
      ms: 120,
      at: 2,
      rd: 2000,
      n: 1
    }
    expect(parseEvent(sample('playback_fetch', fetch), NOW).P).deep.equals(
      fetch
    )
    expect(
      parseEvent(
        sample('playback_fetch', { fk: 'playback', oc: 'error', status: 503 }),
        NOW
      ).P.status
    ).equals(503)
  })
  it('refuses free text, unknown kinds and out-of-range numbers', () => {
    for (const P of [
      { sk: 'teleport' },
      { en: 'vlc' },
      { ek: 'Error: https://x' },
      { ed: 'fragLoadError' },
      { be: -601 },
      { ba: 3601 },
      { td: 61 },
      { pos: -1 },
      { wd: 20000 },
      { url: 'https://develop.teamstation.app/x' },
      { vi: 'https://develop.teamstation.app/api/v1/videos/vid_x/hls' }
    ])
      expect(() =>
        parseEvent(sample('playback_seek', { ...session, ...P }), NOW)
      ).throws()
    expect(() =>
      parseEvent(sample('playback_fetch', { fk: 'stills' }), NOW)
    ).throws()
  })
  it('types every property any event carries, for the strict index mapping', () => {
    for (const rules of Object.values(EVENT_RULES))
      for (const key of Object.keys(rules))
        expect(PROPERTY_TYPES, key).to.have.property(key)
    for (const type of Object.values(PROPERTY_TYPES))
      expect(['keyword', 'double', 'boolean']).includes(type)
  })
  it('labels the routes a live viewer polls', () => {
    for (const route of [
      '/videos/:videoId/playback',
      '/videos/:videoId/hls/:file',
      '/videos/:videoId/stills/:file',
      '/live',
      '/games/:gameId/live-streams/:streamId'
    ])
      expect(
        parseEvent(
          sample('request_completed', { op: 'request', rp: route }),
          NOW
        ).P.rp
      ).equals(route)
  })
})
