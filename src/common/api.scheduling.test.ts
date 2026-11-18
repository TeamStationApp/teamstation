import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TeamStationClient } from './api'
import { input, season } from './autoScheduler/fixtures.test'
import type {
  BuildEvent,
  GameToReschedule,
  SchedulePreview
} from './schedulePreviews'
import {
  buildSchedule,
  type EngineBuild,
  EngineFailureError,
  type EngineLimit,
  type EngineRequest,
  engineResult,
  type EngineSession
} from './scheduler/engine'
import type { ScheduleSettings, ScheduleSetup } from './seasonScheduling'

const SETTINGS: ScheduleSettings = {
  fieldIds: [],
  fieldSize: '50/70',
  gameMinutes: 90,
  bufferMinutes: 10,
  regularGames: 4,
  exhibitionGames: 1,
  doubleheaders: 'never',
  maxGamesOnWeekdays: 1,
  maxGamesOnWeekend: 1,
  preferGameOn: 'weekend',
  startsOn: '2027-03-01',
  endsOn: '2027-07-31',
  blackouts: [],
  windows: [
    {
      from: '2027-03-01',
      hours: [{ weekday: 6, start: '08:00', end: '18:00' }]
    }
  ]
}
const SETUP: ScheduleSetup = {
  leagueId: 'lea/a',
  seasonIds: ['sea_a'],
  fieldIds: ['fld_one'],
  addedFieldIds: [],
  seasons: [
    {
      id: 'sea_a',
      name: 'Demo Regular',
      year: 2027,
      timezone: 'UTC',
      participants: 7,
      exhibitionTeams: 2,
      teams: [{ id: 'tem_a', name: 'Demo Hawks', exhibition: false }],
      saved: true,
      settings: SETTINGS
    }
  ],
  fields: [
    {
      id: 'fld_one',
      name: 'Field 1',
      venueId: 'ven_a',
      venueName: 'Example Park',
      sizes: ['50/70'],
      startsOn: null,
      endsOn: '2027-09-30',
      deleted: false,
      ours: true,
      ownerNames: ['Demo League A']
    }
  ]
}

const TEAM = {
  name: 'Demo Hawks',
  shortName: null,
  logoPath: null,
  logoUrl: null,
  record: null
}

function client(answers: unknown[]): {
  api: TeamStationClient
  calls: Array<[string, string, unknown]>
} {
  const calls: Array<[string, string, unknown]> = []
  const api = new TeamStationClient({
    baseUrl: '/api/v1',
    fetch: (async (url: unknown, init?: { method?: string; body?: string }) => {
      calls.push([
        init?.method ?? 'GET',
        String(url),
        init?.body == null ? undefined : JSON.parse(init.body)
      ])
      const next = answers.shift()
      // A function answers when it is asked, as a slow server would.
      const answer: unknown = typeof next === 'function' ? next() : next
      return answer instanceof Response
        ? answer
        : new Response(JSON.stringify(answer), { status: 200 })
    }) as unknown as typeof fetch
  })
  return { api, calls }
}

describe('api client scheduling setup', () => {
  it('reads and chooses the setup, saves settings and flags exhibition teams', async () => {
    const { api, calls } = client([
      SETUP,
      SETUP,
      { seasonId: 'sea/a', saved: true, settings: SETTINGS },
      { seasonId: 'sea/a', teamId: 'tem/b', exhibition: true },
      [
        { ...TEAM, id: 'tem_a', exhibition: true },
        { ...TEAM, id: 'tem_b' }
      ]
    ])
    expect(await api.scheduleSetup('lea/a')).deep.equals({
      ...SETUP,
      avoidHeadCoachConflicts: true
    })
    await api.saveScheduleSetup('lea/a', {
      seasonIds: [],
      fieldIds: ['fld_one']
    })
    expect(
      (await api.saveScheduleSettings('sea/a', SETTINGS)).settings
    ).deep.equals(SETTINGS)
    await api.setExhibitionTeam('sea/a', 'tem/b', true)
    const teams = await api.seasonTeams('sea/a')
    expect(teams.map(team => team.exhibition)).deep.equals([true, undefined])
    expect(calls).deep.equals([
      ['GET', '/api/v1/leagues/lea%2Fa/schedule-setup', undefined],
      [
        'PUT',
        '/api/v1/leagues/lea%2Fa/schedule-setup',
        { seasonIds: [], fieldIds: ['fld_one'] }
      ],
      ['PUT', '/api/v1/seasons/sea%2Fa/schedule-settings', SETTINGS],
      [
        'PUT',
        '/api/v1/seasons/sea%2Fa/memberships/tem%2Fb',
        { exhibition: true }
      ],
      ['GET', '/api/v1/seasons/sea%2Fa/teams', undefined]
    ])
  })

  it('reads an explicit off setting and sends a deliberate change', async () => {
    const { api, calls } = client([
      { ...SETUP, avoidHeadCoachConflicts: false },
      { ...SETUP, avoidHeadCoachConflicts: true }
    ])
    expect((await api.scheduleSetup('lea/a')).avoidHeadCoachConflicts).equals(
      false
    )
    const choice = {
      seasonIds: SETUP.seasonIds,
      fieldIds: SETUP.fieldIds,
      avoidHeadCoachConflicts: true
    }
    expect(
      (await api.saveScheduleSetup('lea/a', choice)).avoidHeadCoachConflicts
    ).equals(true)
    expect(calls[1]).deep.equals([
      'PUT',
      '/api/v1/leagues/lea%2Fa/schedule-setup',
      choice
    ])
  })

  it('keeps a period’s end date through the setup, and sends it again with a save', async () => {
    const windows = [
      {
        from: '2027-03-01',
        until: '2027-05-20',
        hours: [{ weekday: 6, start: '08:00', end: '18:00' }]
      },
      {
        from: '2027-06-01',
        hours: [{ weekday: 6, start: '09:00', end: '17:00' }]
      }
    ]
    const ended = { ...SETTINGS, windows }
    const { api, calls } = client([
      { ...SETUP, seasons: [{ ...SETUP.seasons[0], settings: ended }] },
      { seasonId: 'sea_a', saved: true, settings: ended }
    ])
    const [season] = (await api.scheduleSetup('lea/a')).seasons
    expect(season.settings.windows).deep.equals(windows)
    // A grid cell saves the season's settings with one number changed.
    const saved = await api.saveScheduleSettings('sea_a', {
      ...season.settings,
      gameMinutes: 100
    })
    expect(calls[1][2]).deep.equals({ ...ended, gameMinutes: 100 })
    expect(saved.settings.windows).deep.equals(windows)
  })

  it('builds, reads, edits and publishes previews, and lists games to reschedule', async () => {
    const preview: SchedulePreview = {
      id: 'spv/1',
      leagueId: 'lea/a',
      mode: 'full',
      existing: 'workAround',
      status: 'open',
      createdAt: '2026-10-22T12:00:00.000Z',
      options: [],
      blocking: 'not enough 50/70 field time to give every team 4 games',
      provenOptimal: true,
      edits: { option: 0, rejectedGameKeys: [], addedGames: [] },
      replacing: 0,
      publishedOption: null,
      publishedAt: null,
      published: [],
      teams: [],
      seasons: [],
      fields: []
    }
    const listed: GameToReschedule = {
      previewId: 'spv/1',
      gameKey: 'g1',
      gameId: null,
      seasonId: 'sea_a',
      homeTeamId: 'tem_a',
      awayTeamId: 'tem_b',
      homeTeamName: 'Demo Hawks',
      awayTeamName: 'Demo Owls',
      startAt: '2027-04-17T14:00:00.000Z',
      endAt: null,
      timezone: 'UTC',
      exhibition: false,
      fieldId: null,
      reason: 'declined'
    }
    const added = {
      seasonId: 'sea_a',
      homeTeamId: 'tem_a',
      awayTeamId: 'tem_b',
      exhibition: false,
      fieldId: 'fld_one',
      size: '50/70' as const,
      startAt: '2027-04-17T14:00:00.000Z',
      endAt: '2027-04-17T15:30:00.000Z'
    }
    const engine = input({ seasons: [], fields: [] })
    const { api, calls } = client([
      { id: 'spv/1', input: engine, solverLimitMs: 120000 },
      preview,
      preview,
      preview,
      { preview, scheduled: 1, awaiting: 0, removed: 0 },
      { items: [listed] }
    ])
    expect(
      await api.buildSchedulePreview('lea/a', {
        mode: 'full',
        existing: 'workAround'
      })
    ).deep.equals(preview)
    await api.schedulePreview('spv/1')
    await api.editSchedulePreview('spv/1', { option: 0, addedGames: [added] })
    expect((await api.publishSchedulePreview('spv/1', 0)).scheduled).equals(1)
    expect(await api.gamesToReschedule('lea/a')).deep.equals([listed])
    expect(calls).deep.equals([
      [
        'POST',
        '/api/v1/leagues/lea%2Fa/schedule-previews/preparations',
        { mode: 'full', existing: 'workAround' }
      ],
      [
        'PUT',
        '/api/v1/schedule-previews/spv%2F1/result',
        engineResult(await buildSchedule({ input: engine, limitMs: 120000 }))
      ],
      ['GET', '/api/v1/schedule-previews/spv%2F1', undefined],
      [
        'PUT',
        '/api/v1/schedule-previews/spv%2F1',
        { option: 0, addedGames: [added] }
      ],
      ['POST', '/api/v1/schedule-previews/spv%2F1/publications', { option: 0 }],
      ['GET', '/api/v1/leagues/lea%2Fa/games-to-reschedule', undefined]
    ])
  })

  it('builds with this platform’s engine', async () => {
    const engine = input({
      seasons: [
        season(
          {
            regularGames: 2,
            exhibitionGames: 0,
            windows: [
              {
                from: '2027-03-01',
                hours: [{ weekday: 6, start: '08:00', end: '18:00' }]
              }
            ]
          },
          { exhibitionTeams: [] }
        )
      ]
    })
    const preview: SchedulePreview = {
      id: 'spv/1',
      leagueId: 'lea',
      mode: 'full',
      existing: 'workAround',
      status: 'open',
      createdAt: '2026-10-22T12:00:00.000Z',
      options: [],
      blocking: null,
      provenOptimal: true,
      edits: { option: 0, rejectedGameKeys: [], addedGames: [] },
      replacing: 0,
      publishedOption: null,
      publishedAt: null,
      published: [],
      teams: [],
      seasons: [],
      fields: []
    }
    const { api, calls } = client([
      { id: 'spv/1', input: engine, solverLimitMs: 120000 },
      preview
    ])
    await api.buildSchedulePreview('lea', { mode: 'full' })
    const sent = calls[1][2] as { options: Array<{ games: unknown[] }> }
    expect(sent.options[0].games.length).greaterThan(0)
    expect(sent).deep.equals(
      engineResult(await buildSchedule({ input: engine, limitMs: 120000 }))
    )
    expect(sent).include({ provenOptimal: true })
  }).timeout(60_000)

  it('sends no result when the engine fails, discards the preparation, and throws its typed failure', async () => {
    const engine = input({ seasons: [], fields: [] })
    const path = require.resolve('./scheduler/engine')
    const real = require.cache[path]
    for (const failure of ['noSolver', 'broken', 'blocked'] as const) {
      require.cache[path] = {
        ...real,
        exports: {
          ...(real?.exports as object),
          buildSchedule: async () => ({
            kind: 'failure',
            failure,
            message: `The build failed: ${failure}`
          })
        }
      } as unknown as NodeJS.Module
      try {
        const { api, calls } = client([
          { id: 'spv/1', input: engine, solverLimitMs: 120000 },
          { discarded: true }
        ])
        let thrown: unknown
        try {
          await api.buildSchedulePreview('lea', { mode: 'full' })
        } catch (error) {
          thrown = error
        }
        expect(thrown, failure).instanceOf(EngineFailureError)
        expect(thrown).include({
          failure,
          message: `The build failed: ${failure}`
        })
        expect(calls.map(([method, url]) => `${method} ${url}`)).deep.equals([
          'POST /api/v1/leagues/lea/schedule-previews/preparations',
          'DELETE /api/v1/schedule-previews/spv%2F1/preparation'
        ])
      } finally {
        require.cache[path] = real
      }
    }
  })

  it('reads a preparation without a time limit as two minutes', async () => {
    const engine = input({ seasons: [], fields: [] })
    const path = require.resolve('./scheduler/engine')
    const real = require.cache[path]
    let limitMs: number | undefined
    require.cache[path] = {
      ...real,
      exports: {
        ...(real?.exports as object),
        buildSchedule: async (request: EngineRequest) => {
          limitMs = request.limitMs
          return { kind: 'failure', failure: 'broken', message: 'Stop.' }
        }
      }
    } as unknown as NodeJS.Module
    try {
      const { api } = client([{ id: 'spv/1', input: engine }, {}])
      await api
        .buildSchedulePreview('lea', { mode: 'full' })
        .catch(() => undefined)
      expect(limitMs).equals(120_000)
    } finally {
      require.cache[path] = real
    }
  })

  it('sends the same result again while offline or the server fails, and stops at a refusal of the result', async () => {
    const engine = input({ seasons: [], fields: [] })
    const refusal = (code: string, status: number): Response =>
      new Response(JSON.stringify({ code, message: 'Refused.' }), { status })
    const preview = { id: 'spv/1' }
    let dropped = false
    let offlinePuts = 0
    const offline = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: async (_url: unknown, init?: { method?: string }) => {
        if (init?.method === 'PUT') offlinePuts++
        if (init?.method === 'PUT' && !dropped) {
          dropped = true
          throw new TypeError('Network request failed')
        }
        return new Response(
          JSON.stringify(
            init?.method === 'POST'
              ? { id: 'spv/1', input: engine, solverLimitMs: 120000 }
              : preview
          ),
          { status: 200 }
        )
      }
    })
    await offline
      .buildSchedulePreview('lea', { mode: 'full' }, {}, [0, 0])
      .catch(() => undefined)
    expect(dropped).equals(true)
    expect(offlinePuts).equals(2)
    // A failing server is asked again too, and a gateway's bare 502.
    const failing = client([
      { id: 'spv/1', input: engine, solverLimitMs: 120000 },
      refusal('unavailable', 503),
      new Response('Bad gateway', { status: 502 }),
      preview
    ])
    await failing.api
      .buildSchedulePreview('lea', { mode: 'full' }, {}, [0, 0])
      .catch(() => undefined)
    expect(failing.calls.filter(([method]) => method === 'PUT')).has.length(3)
    // A refusal of the result itself is final.
    const final = client([
      { id: 'spv/1', input: engine, solverLimitMs: 120000 },
      refusal('badRequest', 400)
    ])
    const error = await final.api
      .buildSchedulePreview('lea', { mode: 'full' }, {}, [0, 0])
      .catch((caught: unknown) => caught)
    expect(String(error)).includes('Refused.')
    expect(final.calls.filter(([method]) => method === 'PUT')).has.length(1)
    // The refused result leaves nothing behind.
    expect(final.calls.map(([method]) => method)).deep.equals([
      'POST',
      'PUT',
      'DELETE'
    ])
  })

  it('reads each preview season’s first day, and a season without one', async () => {
    const season = {
      id: 'sea_a',
      name: 'Demo Regular',
      timezone: 'UTC',
      gameMinutes: 90,
      startsOn: '2027-03-01',
      participants: [],
      exhibitionTeams: []
    }
    const preview = {
      id: 'spv/1',
      leagueId: 'lea/a',
      mode: 'full',
      existing: null,
      status: 'open',
      createdAt: '2026-10-22T12:00:00.000Z',
      options: [],
      blocking: null,
      edits: { option: 0, rejectedGameKeys: [], addedGames: [] },
      replacing: 0,
      publishedOption: null,
      publishedAt: null,
      published: [],
      teams: [],
      seasons: [season],
      fields: []
    }
    const { startsOn: _dropped, ...undated } = season
    const { api } = client([preview, { ...preview, seasons: [undated] }])
    expect((await api.schedulePreview('spv/1')).seasons[0].startsOn).equals(
      '2027-03-01'
    )
    // An answer from a server that does not send it yet still reads.
    expect((await api.schedulePreview('spv/1')).seasons[0].startsOn).equals(
      undefined
    )
  })
})

/** Runs `work` with `./scheduler/engine`'s `buildSchedule` replaced by `fake`. */
async function withEngine(
  fake: (
    request: EngineRequest,
    session: EngineSession
  ) => Promise<EngineBuild>,
  work: () => Promise<void>
): Promise<void> {
  const path = require.resolve('./scheduler/engine')
  const real = require.cache[path]
  require.cache[path] = {
    ...real,
    exports: { ...(real?.exports as object), buildSchedule: fake }
  } as unknown as NodeJS.Module
  try {
    await work()
  } finally {
    require.cache[path] = real
  }
}

describe('api client schedule builds', () => {
  const engine = input({ seasons: [], fields: [] })
  const built: EngineBuild = {
    kind: 'options',
    options: [],
    causes: [],
    blocking: 'not enough field time',
    blockingCause: null,
    targets: [],
    provenOptimal: false
  }
  const preview: SchedulePreview = {
    id: 'spv/1',
    leagueId: 'lea',
    mode: 'full',
    existing: null,
    status: 'open',
    createdAt: '2026-10-22T12:00:00.000Z',
    options: [],
    blocking: 'not enough field time',
    provenOptimal: false,
    edits: { option: 0, rejectedGameKeys: [], addedGames: [] },
    replacing: 0,
    publishedOption: null,
    publishedAt: null,
    published: [],
    teams: [],
    seasons: [],
    fields: []
  }
  const limit: EngineLimit = {
    kind: 'limit',
    stage: 'targets',
    bestGames: 330,
    boundGames: 338,
    solvedMs: 3000
  }

  it('times the preparation and the upload, forwards the engine’s events, passes the limit and answers it', async () => {
    const heard: BuildEvent[] = []
    const asked: EngineLimit[] = []
    let sentRequest: EngineRequest | undefined
    let decision: string | undefined
    await withEngine(
      async (request, session) => {
        sentRequest = request
        session.onProgress?.({ kind: 'phase', phase: 'context', ms: 12 })
        session.onProgress?.(limit)
        decision = await session.onLimit?.(limit)
        return built
      },
      async () => {
        const { api, calls } = client([
          { id: 'spv/1', input: engine, solverLimitMs: 3000 },
          preview
        ])
        const answer = await api.buildSchedulePreview(
          'lea',
          { mode: 'full' },
          {
            onProgress: event => heard.push(event),
            onLimit: async state => {
              asked.push(state)
              return 'continue'
            }
          }
        )
        expect(answer).deep.equals(preview)
        expect(sentRequest).deep.equals({ input: engine, limitMs: 3000 })
        expect(decision).equals('continue')
        expect(asked).deep.equals([limit])
        // The client's own steps are heard starting, then ending, around
        // the engine's.
        expect(heard.map(event => event.kind)).deep.equals([
          'phase-start',
          'phase',
          'phase',
          'limit',
          'phase-start',
          'phase'
        ])
        expect(heard[0]).deep.equals({
          kind: 'phase-start',
          phase: 'preparing'
        })
        expect(heard[1]).include({ kind: 'phase', phase: 'preparing' })
        expect(heard[2]).deep.equals({
          kind: 'phase',
          phase: 'context',
          ms: 12
        })
        expect(heard[4]).deep.equals({ kind: 'phase-start', phase: 'upload' })
        expect(heard[5]).include({ kind: 'phase', phase: 'upload' })
        for (const event of heard)
          if (event.kind === 'phase') expect(event.ms).at.least(0)
        // A schedule taken at the limit is stored as not proven the best.
        expect(calls[1][2]).deep.equals({
          options: [],
          blocking: 'not enough field time',
          provenOptimal: false
        })
      }
    )
  })

  it('cancels the engine on abort, discards the preparation and rejects as canceled', async () => {
    const abort = new AbortController()
    let stopped = false
    await withEngine(
      async (_request, session) =>
        await new Promise<EngineBuild>(resolve => {
          session.signal?.addEventListener('abort', () => {
            stopped = true
            resolve({
              kind: 'failure',
              failure: 'canceled',
              message: 'The build was canceled'
            })
          })
          setTimeout(() => {
            abort.abort()
          }, 0)
        }),
      async () => {
        const { api, calls } = client([
          { id: 'spv/1', input: engine, solverLimitMs: 120000 },
          { discarded: true }
        ])
        const error = await api
          .buildSchedulePreview(
            'lea',
            { mode: 'full' },
            { signal: abort.signal }
          )
          .catch((caught: unknown) => caught)
        expect(stopped).equals(true)
        expect(error).instanceOf(EngineFailureError)
        expect(error).include({ failure: 'canceled' })
        expect(calls.map(([method, url]) => `${method} ${url}`)).deep.equals([
          'POST /api/v1/leagues/lea/schedule-previews/preparations',
          'DELETE /api/v1/schedule-previews/spv%2F1/preparation'
        ])
      }
    )
  })

  it('discards the preparation when the build is canceled at its limit, or aborted before or after the engine runs', async () => {
    // Canceled at the limit: the engine answers the failure itself.
    await withEngine(
      async () => ({
        kind: 'failure',
        failure: 'canceled',
        message: 'The build was canceled'
      }),
      async () => {
        const { api, calls } = client([
          { id: 'spv/1', input: engine, solverLimitMs: 120000 },
          new Response('{"code":"internal","message":"Down."}', { status: 500 })
        ])
        const error = await api
          .buildSchedulePreview('lea', { mode: 'full' })
          .catch((caught: unknown) => caught)
        // The discard's own failure is not the build's.
        expect(error).include({ failure: 'canceled' })
        expect(calls.map(([method]) => method)).deep.equals(['POST', 'DELETE'])
      }
    )
    let ran = false
    await withEngine(
      async () => {
        ran = true
        return built
      },
      async () => {
        // Aborted before it starts: nothing is asked of the server.
        const before = new AbortController()
        before.abort()
        const early = client([])
        expect(
          await early.api
            .buildSchedulePreview(
              'lea',
              { mode: 'full' },
              { signal: before.signal }
            )
            .catch((caught: unknown) => caught)
        ).include({ failure: 'canceled' })
        expect(early.calls).deep.equals([])
        // Aborted while the server prepares: the engine never runs.
        const during = new AbortController()
        const preparing = client([
          () => {
            during.abort()
            return { id: 'spv/1', input: engine, solverLimitMs: 120000 }
          },
          { discarded: true }
        ])
        const answer = preparing.api
          .buildSchedulePreview(
            'lea',
            { mode: 'full' },
            { signal: during.signal }
          )
          .catch((caught: unknown) => caught)
        expect(await answer).include({ failure: 'canceled' })
        expect(ran).equals(false)
        expect(preparing.calls.map(([method]) => method)).deep.equals([
          'POST',
          'DELETE'
        ])
        // Aborted as the engine returns: nothing is sent.
        const returning = new AbortController()
        const returned = client([
          { id: 'spv/1', input: engine, solverLimitMs: 120000 },
          { discarded: true }
        ])
        await withEngine(
          async () => {
            returning.abort()
            return built
          },
          async () => {
            expect(
              await returned.api
                .buildSchedulePreview(
                  'lea',
                  { mode: 'full' },
                  { signal: returning.signal }
                )
                .catch((caught: unknown) => caught)
            ).include({ failure: 'canceled' })
          }
        )
        expect(returned.calls.map(([method]) => method)).deep.equals([
          'POST',
          'DELETE'
        ])
        // Aborted while the result waits to be sent again.
        const retrying = new AbortController()
        const offline = client([
          { id: 'spv/1', input: engine, solverLimitMs: 120000 },
          new Response('{"code":"unavailable","message":"Later."}', {
            status: 503
          }),
          { discarded: true }
        ])
        const waiting = offline.api
          .buildSchedulePreview(
            'lea',
            { mode: 'full' },
            { signal: retrying.signal },
            [20]
          )
          .catch((caught: unknown) => caught)
        await new Promise(resolve => setTimeout(resolve, 5))
        retrying.abort()
        expect(await waiting).include({ failure: 'canceled' })
        expect(offline.calls.map(([method]) => method)).deep.equals([
          'POST',
          'PUT',
          'DELETE'
        ])
      }
    )
  })

  it('discards the preparation when the engine throws, and rethrows its error', async () => {
    for (const thrown of [
      new RangeError('Invalid time zone specified: Mars/Olympus'),
      new Error('The scheduler stopped working')
    ]) {
      await withEngine(
        async () => {
          throw thrown
        },
        async () => {
          const { api, calls } = client([
            { id: 'spv/1', input: engine, solverLimitMs: 120000 },
            { discarded: true }
          ])
          const error = await api
            .buildSchedulePreview('lea', { mode: 'full' })
            .catch((caught: unknown) => caught)
          expect(error).equals(thrown)
          expect(calls.map(([method, url]) => `${method} ${url}`)).deep.equals([
            'POST /api/v1/leagues/lea/schedule-previews/preparations',
            'DELETE /api/v1/schedule-previews/spv%2F1/preparation'
          ])
        }
      )
    }
  })

  it('discards the preparation when the upload runs out of retries', async () => {
    await withEngine(
      async () => built,
      async () => {
        const { api, calls } = client([
          { id: 'spv/1', input: engine, solverLimitMs: 120000 },
          new Response('{"code":"unavailable","message":"Later."}', {
            status: 503
          }),
          new Response('{"code":"unavailable","message":"Still later."}', {
            status: 503
          }),
          { discarded: true }
        ])
        const error = await api
          .buildSchedulePreview('lea', { mode: 'full' }, {}, [0])
          .catch((caught: unknown) => caught)
        expect(String(error)).includes('Still later.')
        expect(calls.map(([method]) => method)).deep.equals([
          'POST',
          'PUT',
          'PUT',
          'DELETE'
        ])
      }
    )
  })

  it('opens the preview the server kept when Cancel comes after its result was stored', async () => {
    await withEngine(
      async () => built,
      async () => {
        const retrying = new AbortController()
        const { api, calls } = client([
          { id: 'spv/1', input: engine, solverLimitMs: 120000 },
          // The server stored the result, but its answer was lost.
          new Response('{"code":"unavailable","message":"Later."}', {
            status: 503
          }),
          new Response(
            '{"code":"conflict","message":"This schedule was already built"}',
            { status: 409 }
          ),
          preview
        ])
        const waiting = api
          .buildSchedulePreview(
            'lea',
            { mode: 'full' },
            { signal: retrying.signal },
            [20]
          )
          .catch((caught: unknown) => caught)
        await new Promise(resolve => setTimeout(resolve, 5))
        retrying.abort()
        expect(await waiting).deep.equals(preview)
        expect(calls.map(([method, url]) => `${method} ${url}`)).deep.equals([
          'POST /api/v1/leagues/lea/schedule-previews/preparations',
          'PUT /api/v1/schedule-previews/spv%2F1/result',
          'DELETE /api/v1/schedule-previews/spv%2F1/preparation',
          'GET /api/v1/schedule-previews/spv%2F1'
        ])
      }
    )
    // A published preview the server kept opens the same way.
    await withEngine(
      async () => built,
      async () => {
        const { api } = client([
          { id: 'spv/1', input: engine, solverLimitMs: 120000 },
          new Response('{"code":"internal","message":"Lost."}', {
            status: 500
          }),
          new Response('{"code":"badRequest","message":"Refused."}', {
            status: 400
          }),
          new Response(
            '{"code":"conflict","message":"This schedule was already built"}',
            { status: 409 }
          ),
          { ...preview, status: 'published' }
        ])
        expect(
          await api
            .buildSchedulePreview('lea', { mode: 'full' }, {}, [0])
            .catch((caught: unknown) => caught)
        ).include({ id: 'spv/1', status: 'published' })
      }
    )
    // Before any result is sent, a refused discard is still a cancel.
    await withEngine(
      async () => ({
        kind: 'failure',
        failure: 'canceled',
        message: 'The build was canceled'
      }),
      async () => {
        const { api, calls } = client([
          { id: 'spv/1', input: engine, solverLimitMs: 120000 },
          new Response('{"code":"conflict","message":"Built."}', {
            status: 409
          })
        ])
        expect(
          await api
            .buildSchedulePreview('lea', { mode: 'full' })
            .catch((caught: unknown) => caught)
        ).include({ failure: 'canceled' })
        expect(calls.map(([method]) => method)).deep.equals(['POST', 'DELETE'])
      }
    )
  })

  it('says why a recalculation placed nothing again, rather than open the preview the server discarded', async () => {
    await withEngine(
      async () => built,
      async () => {
        const nothing =
          'None of the rejected games could be placed again (not enough field time). The preview is as it was.'
        const { api, calls } = client([
          { id: 'spv/2', input: engine, solverLimitMs: 120000 },
          new Response(JSON.stringify({ code: 'conflict', message: nothing }), {
            status: 409
          }),
          // The server discarded the recalculation itself, so it refuses
          // the discard as built.
          new Response(
            '{"code":"conflict","message":"This schedule was already built"}',
            { status: 409 }
          ),
          { ...preview, id: 'spv/2', status: 'discarded' }
        ])
        const error = await api
          .buildSchedulePreview(
            'lea',
            { mode: 'full', fromPreviewId: 'spv/1', option: 0 },
            {},
            [0]
          )
          .catch((caught: unknown) => caught)
        expect(error).instanceOf(Error)
        expect(String(error)).includes(nothing)
        expect(calls.map(([method, url]) => `${method} ${url}`)).deep.equals([
          'POST /api/v1/leagues/lea/schedule-previews/preparations',
          'PUT /api/v1/schedule-previews/spv%2F2/result',
          'DELETE /api/v1/schedule-previews/spv%2F2/preparation',
          'GET /api/v1/schedule-previews/spv%2F2'
        ])
      }
    )
  })

  it('discards at once when Cancel comes during a wait between uploads', async () => {
    await withEngine(
      async () => built,
      async () => {
        const waiting = new AbortController()
        const { api, calls } = client([
          { id: 'spv/1', input: engine, solverLimitMs: 120000 },
          new Response('{"code":"unavailable","message":"Later."}', {
            status: 503
          }),
          { discarded: true }
        ])
        const started = Date.now()
        const build = api
          .buildSchedulePreview(
            'lea',
            { mode: 'full' },
            { signal: waiting.signal },
            [60_000]
          )
          .catch((caught: unknown) => caught)
        await new Promise(resolve => setTimeout(resolve, 5))
        waiting.abort()
        expect(await build).include({ failure: 'canceled' })
        expect(Date.now() - started).lessThan(5000)
        expect(calls.map(([method]) => method)).deep.equals([
          'POST',
          'PUT',
          'DELETE'
        ])
      }
    )
  })
})
