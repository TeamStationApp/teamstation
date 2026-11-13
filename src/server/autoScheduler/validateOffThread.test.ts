import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mock } from 'node:test'
import type * as WorkerTypes from 'node:worker_threads'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  field,
  hoursOn,
  input,
  season
} from '../../common/autoScheduler/fixtures.test'
import type {
  EngineResult,
  PlannedGame
} from '../../common/autoScheduler/types'
import type { Snapshot } from './snapshot'
import { validateOffThread } from './validateOffThread'

const blocked: EngineResult = { options: [], blocking: 'No games fit' }
/** What the server stores for a blocked result: its own reason. */
const serverBlocked: EngineResult = {
  options: [],
  blocking: 'No game fits the selected fields, time windows and constraints.'
}
const snapshot = (): Snapshot => ({
  engine: input(),
  existing: 'workAround',
  teamIds: null,
  knownGameIds: [],
  replaceGameIds: [],
  reschedules: [],
  teams: [],
  seasons: [],
  fields: []
})
const workerModule = createRequire(__filename)(
  'node:worker_threads'
) as typeof WorkerTypes

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    return String(error)
  }
  throw new Error('Expected validation to fail')
}

describe('isolated device result validation', function () {
  this.timeout(30000)
  afterEach(() => {
    mock.restoreAll()
  })
  it('keeps the request loop responsive while validating 400 games and their summaries', async () => {
    const snap = snapshot()
    const teams = Array.from({ length: 8 }, (_, i) => `team_${i}`)
    const hours = hoursOn([0, 1, 2, 3, 4, 5, 6], '00:00', '24:00')
    const fields = Array.from({ length: 4 }, (_, i) =>
      field({
        id: `field_${i}`,
        availability: {
          startsOn: null,
          endsOn: null,
          hours,
          blackouts: [],
          timezone: 'UTC'
        }
      })
    )
    snap.engine = input({
      notBefore: Date.parse('2027-01-01T00:00:00Z'),
      fields,
      weeklyGames: [],
      teamNames: {},
      seasons: [
        season(
          {
            fieldIds: fields.map(field => field.id),
            startsOn: '2027-01-01',
            endsOn: '2027-12-31',
            gameMinutes: 60,
            bufferMinutes: 0,
            regularGames: 200,
            exhibitionGames: 0,
            doubleheaders: 'allowed',
            windows: [{ from: '2027-01-01', hours }]
          },
          { participants: teams, exhibitionTeams: [] }
        )
      ]
    })
    const games: PlannedGame[] = Array.from({ length: 400 }, (_, i) => {
      const start =
        Date.parse('2027-01-01T10:00:00Z') + Math.floor(i / 4) * 86400000
      return {
        key: `game_${i}`,
        seasonId: 'sea_demo',
        fieldId: fields[i % 4].id,
        homeTeamId: teams[2 * (i % 4)],
        awayTeamId: teams[2 * (i % 4) + 1],
        exhibition: false,
        size: '50/70',
        startAt: new Date(start).toISOString(),
        endAt: new Date(start + 3600000).toISOString()
      }
    })
    let ticks = 0
    let latest = Date.now()
    let longest = 0
    const timer = setInterval(() => {
      const now = Date.now()
      longest = Math.max(longest, now - latest)
      latest = now
      ticks++
    }, 10)
    try {
      const result = await validateOffThread(snap, {
        options: [{ games, fairness: [], score: [], reasons: [], unmet: [] }],
        blocking: null
      })
      expect(result.options[0].games).has.length(400)
      expect(ticks).greaterThan(10)
      expect(longest).lessThan(500)
    } finally {
      clearInterval(timer)
    }
  })
  it('returns validation errors, limits worker duration and recovers for later requests', async () => {
    const invalid = snapshot()
    invalid.engine.seasons[0].settings.endsOn = '9999-12-31'
    const empty: EngineResult = {
      options: [{ games: [], fairness: [], reasons: [], unmet: [], score: [] }],
      blocking: null
    }
    expect(await failure(validateOffThread(invalid, empty))).includes(
      'too many field days'
    )
    const broken = snapshot()
    broken.engine.fields[0].availability.timezone = 'Not/AZone'
    expect(await failure(validateOffThread(broken, empty))).includes(
      'validation failed'
    )
    expect(await failure(validateOffThread(snapshot(), blocked, 1))).includes(
      'too long'
    )
    expect(await validateOffThread(snapshot(), blocked)).deep.equals(
      serverBlocked
    )
  })
  it('handles worker crashes and premature exits without poisoning the queue', async () => {
    for (const event of ['error', 'exit']) {
      class FailedWorker extends EventEmitter {
        constructor() {
          super()
          queueMicrotask(() =>
            this.emit(event, new Error('fixture worker failure'))
          )
        }

        terminate = async (): Promise<number> => 0
      }
      mock.method(
        workerModule,
        'Worker',
        FailedWorker as unknown as typeof WorkerTypes.Worker
      )
      expect(await failure(validateOffThread(snapshot(), blocked))).includes(
        'validation stopped'
      )
      mock.restoreAll()
    }
    expect(await validateOffThread(snapshot(), blocked)).deep.equals(
      serverBlocked
    )
  })
  it('bounds queued requests and processes accepted requests in order', async () => {
    let created = 0
    class AnswerWorker extends EventEmitter {
      constructor() {
        super()
        created++
        setImmediate(() => this.emit('message', { ok: true, result: blocked }))
      }

      terminate = async (): Promise<number> => 0
    }
    mock.method(
      workerModule,
      'Worker',
      AnswerWorker as unknown as typeof WorkerTypes.Worker
    )
    const requests = Array.from(
      { length: 4 },
      async () => await validateOffThread(snapshot(), blocked)
    )
    expect(await failure(validateOffThread(snapshot(), blocked))).includes(
      'busy'
    )
    expect(await Promise.all(requests)).deep.equals(Array(4).fill(blocked))
    expect(created).equals(4)
  })
  it('loads nothing in the worker that cannot be torn down with it', () => {
    // A native addon loaded in a worker crashes the process when the worker
    // ends, so the checks the worker runs stay clear of the server's modules.
    const probe = spawnSync(
      process.execPath,
      [
        '-r',
        require.resolve('sucrase/register'),
        '-e',
        `require(${JSON.stringify(require.resolve('./placementChecks'))});
        console.log(JSON.stringify(Object.keys(require.cache)))`
      ],
      { encoding: 'utf8' }
    )
    const loaded = JSON.parse(probe.stdout) as string[]
    expect(loaded.some(file => file.endsWith('.node'))).equals(false)
    expect(loaded.some(file => file.includes('/server/db/'))).equals(false)
  })
})
