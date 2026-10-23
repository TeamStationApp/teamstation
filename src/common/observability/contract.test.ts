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
  })
})
