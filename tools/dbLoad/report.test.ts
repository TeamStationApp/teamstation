import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { Tally } from './actors'
import {
  assertThresholds,
  buildReport,
  connectionFigures,
  eventFigures,
  longestGap,
  percentile,
  type ReportData,
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

  describe('--assert', function () {
    /** A run that meets every limit: each case then spoils just one figure. */
    const passing = (): ReportData => {
      const tally = new Tally()
      tally.postMs.push(100, 200)
      tally.postAt.push(1000, 2000)
      tally.deliveryLagMs.push(50)
      tally.framesDelivered = 1
      tally.frameSeconds.push(60)
      tally.socketsOpened = 2000
      return buildReport({
        title: 'run',
        startedAt: 0,
        finishedAt: 61_000,
        measurements: tally,
        samples: [
          sample({
            backends: [
              {
                applicationName: 'api',
                state: 'idle',
                pooled: true,
                count: 90
              },
              {
                applicationName: 'relay',
                state: 'idle',
                pooled: false,
                count: 5
              },
              {
                applicationName: 'dbload-sampler',
                state: 'active',
                pooled: false,
                count: 3
              }
            ]
          })
        ],
        statements: [],
        sequentialScans: [],
        hasStatements: false,
        events: [{ event: 'teamMerge', startedAt: 0, ms: 10_000 }],
        rig: { cpuPercent: 40, loopDelayP95Ms: 12 }
      })
    }
    const limits = { poolLimit: 97 }
    const missed = (
      change: (data: ReportData) => void,
      options: Parameters<typeof assertThresholds>[1] = limits
    ): string[] => {
      const data = passing()
      change(data)
      return assertThresholds(data, options)
    }

    it('passes a run within every limit, not counting its own connections', function () {
      expect(assertThresholds(passing(), limits)).deep.equals([])
    })

    it('fails each threshold on its own', function () {
      const one = (change: (data: ReportData) => void, words: RegExp): void => {
        const lines = missed(change)
        expect(lines.length, lines.join('; ')).equals(1)
        expect(lines[0]).matches(words)
      }
      one(data => {
        data.connections.peakPooled = 98
      }, /server connections: peak 98/)
      one(data => {
        data.connections.peakDirectServers = 6
      }, /direct connections: peak 6/)
      one(data => {
        data.errors['too-many-clients'] = 1
      }, /too many clients: seen 1/)
      one(data => {
        data.errors['http-503'] = 1
        data.errors['socket-http-503'] = 1
      }, /503 rate: 2 of 2000/)
      one(data => {
        data.answers = 0
      }, /503 rate: no requests/)
      one(data => {
        data.postP95Ms = 500
      }, /p95 POST: 500 ms/)
      one(data => {
        data.postP95Ms = null
      }, /p95 POST: no data/)
      one(data => {
        data.deliveryLagP95Ms = 1000
      }, /p95 delivery lag: 1000 ms/)
      one(data => {
        data.deliveryLagP95Ms = null
      }, /p95 delivery lag: no data/)
      one(data => {
        data.longestDeliveryGapSeconds = 61
      }, /recovery: 61 s/)
      one(data => {
        data.longestDeliveryGapSeconds = null
      }, /recovery: no frames/)
      one(data => {
        data.events[0].postP95DuringMs = 1001
      }, /event teamMerge: p95 scoring 1001 ms/)
      one(data => {
        data.events[0].ms = 60_001
      }, /event teamMerge: 60 s, above/)
      one(data => {
        data.oldestTransactionSeconds = 61
      }, /oldest transaction: 61 s/)
    })

    it('takes servers logs and a missing pool limit as misses too', function () {
      expect(
        missed(() => undefined, { poolLimit: 97, tooManyClients: 2 })
      ).deep.equals(['too many clients: seen 2 times'])
      expect(missed(() => undefined, {})).deep.equals([
        'server connections: no --pool-limit to hold them to'
      ])
      expect(assertThresholds(passing())).deep.equals([
        'server connections: no --pool-limit to hold them to'
      ])
    })

    it('reads the rig and each event in what it renders', function () {
      const text = renderReport(passing())
      expect(text).includes(
        'rig: CPU 40% of one core, event loop delay p95 12.0 ms'
      )
      expect(text).includes('longest time with no frame: 1 s')
      expect(text).matches(/event teamMerge: 10000 ms, 2 posts during it/)
      const none = { ...passing(), rig: null, longestDeliveryGapSeconds: null }
      expect(renderReport(none)).includes('rig: no data')
      expect(renderReport(none)).includes('longest time with no frame: no data')
    })
  })

  it('finds the longest gap in frames, up to the end of the run', function () {
    expect(longestGap([], 100_000)).equals(null)
    expect(longestGap([10, 80, 90], 95_000)).equals(70)
    expect(longestGap([10, 20], 95_000)).equals(75)
  })

  it('looks for an event in scoring for as long as its effect lasts', function () {
    const [short, long] = eventFigures(
      [
        { event: 'signOut', startedAt: 1000, ms: 5 },
        { event: 'teamMerge', startedAt: 100_000, ms: 40_000 }
      ],
      [10, 20, 30],
      [500, 20_000, 139_000]
    )
    expect(short.postsDuring).equals(1)
    expect(short.postP95DuringMs).equals(20)
    expect(long.postP95DuringMs).equals(30)
  })
})
