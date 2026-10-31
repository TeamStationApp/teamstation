import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { Tally } from './actors'
import {
  buildReport,
  connectionFigures,
  percentile,
  renderReport,
  slowestRequests,
  writeReport
} from './report'
import type { Sample } from './sampler'

const sample = (partial: Partial<Sample> = {}): Sample => ({
  at: 1,
  backends: [],
  lockWaiters: 0,
  objectLockWaiters: 0,
  oldestTransactionSeconds: 0,
  statements: null,
  ...partial
})

describe('the load report', function () {
  it('takes percentiles by rank, and has none of nothing', function () {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(hundred, 50)).equals(50)
    expect(percentile(hundred, 95)).equals(95)
    expect(percentile([7], 95)).equals(7)
    expect(percentile([], 95)).equals(null)
  })

  it('counts peaks of backends, pooled and direct, by name and state', function () {
    const figures = connectionFigures([
      sample({
        backends: [
          { applicationName: 'a', state: 'idle', pooled: true, count: 3 },
          { applicationName: 'b', state: 'active', pooled: false, count: 2 }
        ]
      }),
      sample({
        backends: [
          { applicationName: 'a', state: 'active', pooled: true, count: 1 },
          { applicationName: 'b', state: 'active', pooled: false, count: 6 }
        ]
      })
    ])
    expect(figures.peak).equals(7)
    expect(figures.peakPooled).equals(3)
    expect(figures.peakDirect).equals(6)
    expect(figures.peakByApplication).deep.equals({ a: 3, b: 6 })
    expect(figures.peakByState).deep.equals({ idle: 3, active: 7 })
  })

  it('ranks routes and account kinds by p95', function () {
    const slow = slowestRequests([
      { route: 'GET /a', accountKind: 'viewer', ms: 10 },
      { route: 'GET /a', accountKind: 'viewer', ms: 30 },
      { route: 'GET /a', accountKind: 'worstCase', ms: 900 },
      { route: 'GET /b', accountKind: 'viewer', ms: 20 }
    ])
    expect(slow[0]).deep.equals({
      route: 'GET /a',
      accountKind: 'worstCase',
      count: 1,
      p95Ms: 900
    })
    expect(slow[1].p95Ms).equals(30)
    expect(slow[1].count).equals(2)
  })

  it('works out statements per delivery, and says so when it cannot', function () {
    const tally = new Tally()
    tally.postMs.push(10, 20, 30, 40)
    tally.framesDelivered = 8
    tally.fail('http-503')
    tally.fail('http-503')
    tally.fail('unreachable')
    const data = buildReport({
      title: 'run',
      startedAt: 0,
      finishedAt: 60_000,
      measurements: tally,
      samples: [
        sample({
          lockWaiters: 4,
          objectLockWaiters: 1,
          oldestTransactionSeconds: 2
        })
      ],
      statements: [
        { queryId: '1', query: 'select 1', calls: 100, totalMs: 5, rows: 100 },
        { queryId: '2', query: 'select\n 2', calls: 20, totalMs: 1, rows: 0 }
      ],
      sequentialScans: [{ table: 'events', scans: 2, rows: 5000 }],
      hasStatements: true
    })
    expect(data.seconds).equals(60)
    expect(data.statementsTotal).equals(120)
    expect(data.statementsPerDelivery).equals(30)
    expect(data.statementsPerFrame).equals(15)
    expect(data.errorTotal).equals(3)
    expect(data.peakLockWaiters).equals(4)
    const text = renderReport(data)
    expect(text).contains('per delivery (each scoring post): 30.0')
    expect(text).contains('http-503: 2')
    expect(text).contains('select 2')
    expect(text).contains('events: 2 scans of 5000 rows')
  })

  it('reports an empty run as no data, never zeros', function () {
    const data = buildReport({
      title: 'nothing',
      startedAt: 0,
      finishedAt: 1000,
      measurements: new Tally(),
      samples: [],
      statements: [],
      sequentialScans: [],
      hasStatements: false
    })
    expect(data.postP95Ms).equals(null)
    expect(data.statementsPerDelivery).equals(null)
    const text = renderReport(data)
    expect(text).contains('p95 no data')
    expect(text).contains('per delivery (each scoring post): no data')
  })

  it('writes a file to read and a file to parse', function () {
    const dir = mkdtempSync(join(tmpdir(), 'dbload-report-'))
    try {
      const data = buildReport({
        title: 'files',
        startedAt: 0,
        finishedAt: 1000,
        measurements: new Tally(),
        samples: [],
        statements: [],
        sequentialScans: [],
        hasStatements: false
      })
      writeReport(join(dir, 'load.log'), data)
      expect(readFileSync(join(dir, 'load.log'), 'utf8')).contains('# files')
      expect(
        JSON.parse(readFileSync(join(dir, 'load.log.json'), 'utf8')).title
      ).equals('files')
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
