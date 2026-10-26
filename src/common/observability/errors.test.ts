import { globSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { errorRecord, safeErrorEvent } from './errors'
import { RateLimit } from './rateLimit'
import { SERVER_CODE_FILES } from './serverCodeFiles'

describe('safe error reconstruction and rate counters', () => {
  it('keeps compiled server locations closed, complete and idempotent', () => {
    const source = globSync('src/server/**/*.ts').filter(
      file => !/\.(?:test|d)\.ts$/.test(file)
    )
    for (const file of source)
      expect(SERVER_CODE_FILES.has(file.slice(4, -3) + '.js'), file).equals(
        true
      )
    const raw = {
      event_id: '00000000000040008000000000000001',
      timestamp: Date.now() / 1000,
      exception: {
        values: [
          {
            type: 'TypeError',
            stacktrace: {
              frames: [
                {
                  filename: 'app:///lib/server/index.js',
                  lineno: 12,
                  colno: 8
                },
                {
                  filename: 'C:\\private\\lib\\server\\routes\\auth.js',
                  lineno: 20,
                  colno: 0
                },
                {
                  filename: '/private/lib/server/private-canary.js',
                  lineno: 4,
                  colno: 2
                },
                {
                  filename: '/private/lib/server/routes/auth.js?private-canary',
                  lineno: 4,
                  colno: 2
                }
              ]
            }
          }
        ]
      }
    }
    const record = errorRecord(raw, 'TS srv')
    expect(record.P).includes({
      f0: 'server/index.js',
      l0: 12,
      c0: 8,
      f1: 'server/routes/auth.js',
      l1: 20,
      c1: 0
    })
    expect(record.P).not.has.property('f2')
    expect(errorRecord(safeErrorEvent(raw), 'TS srv')).deep.equals(record)
    expect(JSON.stringify(record)).not.contains('private')
    expect([...SERVER_CODE_FILES].every(file => file.length <= 128)).equals(
      true
    )
  })
  it('retains usable release bundle locations without URLs or arbitrary filenames', () => {
    const frames = [
      'app-ABCDEFG2.js',
      'index.android.bundle',
      'main.jsbundle'
    ].map((filename, index) => ({
      filename: 'https://example.test/private/' + filename,
      lineno: 1,
      colno: 12345 + index
    }))
    const input = {
      event_id: '00000000000040008000000000000001',
      timestamp: Date.now() / 1000,
      exception: { values: [{ type: 'TypeError', stacktrace: { frames } }] }
    }
    const record = errorRecord(input, 'TS')
    expect(record.P).includes({
      f0: 'app-ABCDEFG2.js',
      l0: 1,
      c0: 12345,
      f1: 'index.android.bundle',
      c1: 12346,
      f2: 'main.jsbundle',
      c2: 12347
    })
    expect(JSON.stringify(record)).not.contains('example.test')
    expect(errorRecord(safeErrorEvent(input), 'TS')).deep.equals(record)
    for (const colno of [-1, 0.5, 100000001, 'private-canary']) {
      frames[0] = { ...frames[0], colno: colno as number }
      expect(errorRecord(input, 'TS').P).not.has.property('c0')
    }
    frames[0] = { filename: 'app-private-canary.js', lineno: 1, colno: 0 }
    expect(JSON.stringify(errorRecord(input, 'TS'))).not.contains(
      'private-canary'
    )
  })
  it('preserves opaque native crash IDs exactly across retries', () => {
    const raw = {
      event_id: '00000000000000000000000000000001',
      level: 'fatal',
      timestamp: new Date().toISOString(),
      release: 'app.teamstation.cameraman@1.0+1',
      exception: { values: [{ type: 'SIGSEGV', stacktrace: { frames: [] } }] }
    }
    const first = errorRecord(raw, 'cam')
    expect(first.I).equals('00000000-0000-0000-0000-000000000001')
    expect(first.L).equals('fatal')
    expect(errorRecord(raw, 'cam')).deep.equals(first)
  })
  it('drops secret/chat canaries from every SDK bag and admits only known code locations', () => {
    const canary = 'chat-secret-canary'
    const raw = {
      event_id: '00000000000040008000000000000001',
      timestamp: Date.now() / 1000,
      level: 'fatal',
      message: canary,
      user: { id: canary },
      request: { data: canary },
      breadcrumbs: [canary],
      contexts: { chat: canary },
      extra: { secret: canary },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: canary,
            stacktrace: {
              frames: [
                null,
                { filename: canary, lineno: 4 },
                {
                  filename: 'file:///private/App.tsx',
                  lineno: 12,
                  vars: { secret: canary }
                },
                { filename: 'api.ts', lineno: 0 },
                { filename: 'api.ts', lineno: 1.5 },
                { filename: 'api.ts', lineno: 1000001 },
                { filename: 'api.ts', lineno: 4 }
              ]
            }
          }
        ]
      }
    }
    const safe = safeErrorEvent(raw)
    expect(JSON.stringify(safe)).not.contains(canary)
    const event = errorRecord(raw, 'TS web')
    expect(event.P).deep.equals({
      op: 'other',
      ec: 'internal',
      c: 'TypeError',
      f0: 'App.tsx',
      l0: 12,
      f1: 'api.ts',
      l1: 4
    })
    expect(event.L).equals('fatal')
    const native = errorRecord(
      {
        ...raw,
        timestamp: new Date(raw.timestamp * 1000).toISOString(),
        release: 'app.teamstation.director@1.2.3+4'
      },
      'TS dir'
    )
    expect(native.D).equals(new Date(raw.timestamp * 1000).toISOString())
    expect(native.V).equals('1.2.3+4')
    expect(
      safeErrorEvent({ ...raw, release: canary, timestamp: canary }).release
    ).equals(undefined)
    for (const input of [
      null,
      [],
      {},
      { exception: { values: [] } },
      { exception: { values: [{ type: canary, stacktrace: { frames: [] } }] } }
    ])
      expect(JSON.stringify(safeErrorEvent(input))).not.contains(canary)
    expect(errorRecord({ event_id: raw.event_id }, 'cam').L).equals('error')
    expect(() => errorRecord({}, 'cam')).throws()
  })
  it('bounds per-source and global work and expires counters without storing addresses', () => {
    let now = 60000
    const per = new RateLimit(2, () => now)
    expect(per.allow('one')).equals(true)
    expect(per.allow('one')).equals(true)
    expect(per.allow('one')).equals(false)
    const all = new RateLimit(20000, () => now)
    for (let i = 0; i < 10000; i++) expect(all.allow(String(i))).equals(true)
    expect(all.allow('extra')).equals(false)
    now += 60000
    expect(all.allow('extra')).equals(true)
    expect(per.allow('one')).equals(true)
  })
})
