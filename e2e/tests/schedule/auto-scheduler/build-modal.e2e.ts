import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import {
  apiGet,
  bodyText,
  BUILDING,
  buildLog,
  countsShown,
  DISCARD,
  expectExactCounts,
  firstShown,
  LIMIT_REACHED,
  MODULE,
  NO_SOLVER,
  openScheduler,
  phaseTimingsText,
  PREPARATIONS,
  PREVIEW_OPEN,
  previewRequested,
  requested,
  RESULT,
  SHORT_SEASON_LINES,
  WORKER
} from '../../../rigs/schedule/autoScheduler'

/**
 * A schedule build on the web shows in a modal: a log of each step and the
 * solver's progress, with Cancel, which discards the preparation. In the
 * `packed-league-limit` world (the packed league with a 3 s solver limit)
 * the build stops at its limit and the admin goes on, or uses the best
 * schedule found. A browser without WebAssembly is told it can't build.
 * After a build the Auto-Scheduler offers the previous preview, and the
 * packed league's 338 games publish in seconds.
 */

const COMMAND = (scenario: string): string =>
  `npm run -s e2e -- run schedule/auto-scheduler/build-modal#${scenario} --surface web-chromium --stack <stack>`

/** The world's solver limit, which a server with `testSettings` sends. */
const WORLD_LIMIT_MS = 3000

/**
 * A stack's server runs without `testSettings`, so it sends every build the
 * full two minutes and ignores the world's 3 s. This stands in for that
 * setting: it gives the page's build the world's limit, and keeps what the
 * server sent where the scenario can read it.
 */
const WORLD_LIMIT = `
  window.__solverLimits = []
  const fetchBefore = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const response = await fetchBefore(input, init)
    const url = new URL(String(input && input.url ? input.url : input), location.href)
    if (!/\\/schedule-previews\\/preparations$/.test(url.pathname) || !response.ok)
      return response
    const body = await response.json()
    window.__solverLimits.push(body.solverLimitMs)
    body.solverLimitMs = ${WORLD_LIMIT_MS}
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: response.headers
    })
  }
`

/** The limits the server sent the page's builds, before the stand-in. */
async function sentLimits(web: WebSession): Promise<number[]> {
  return await web.page.evaluate(
    () => (window as unknown as { __solverLimits: number[] }).__solverLimits
  )
}

/** How long publishing the packed league's 338 games may take on a stack. */
const PUBLISH_BOUND_MS = 10_000

const TIME_LIMIT_LINE = 'Why: Not proven optimal: stopped at the time limit.'

/** A limit with no schedule found yet. */
const NONE_YET = 'hasn’t found a schedule yet'

/** The log's line, and the line under the title, when such a limit is used. */
const USING_FIRST = 'Using the first schedule found'
const AWAITING_FIRST =
  'Waiting for the solver’s first schedule, which will be used as soon as it is found. If none is found within another time limit, the build stops.'

/** The modal's title, or null while no modal shows. */
async function modalTitle(web: WebSession): Promise<string | null> {
  return await web.page.evaluate(() => {
    const heading = document.querySelector(
      '[data-testid="schedule-build-modal"] [role="heading"]'
    )
    return heading == null ? null : (heading as HTMLElement).innerText
  })
}

/** The modal's text, line by line. */
async function modalText(web: WebSession): Promise<string[]> {
  return await web.page.evaluate(() => {
    const modal = document.querySelector('[data-testid="schedule-build-modal"]')
    return modal == null ? [] : (modal as HTMLElement).innerText.split('\n')
  })
}

/** Waits until the modal's title is one of `titles`, or the preview opens. */
async function modalOrPreview(
  web: WebSession,
  titles: readonly string[],
  timeoutMs: number
): Promise<string> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const title = await modalTitle(web)
    if (title != null && titles.includes(title)) return title
    if (
      title == null &&
      (await bodyText(web)).toLowerCase().includes(PREVIEW_OPEN.toLowerCase())
    )
      return PREVIEW_OPEN
    if (Date.now() > until)
      throw new Error(
        `Neither ${JSON.stringify(titles)} nor the preview showed`
      )
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** The scheduler workers the page is running. */
function schedulerWorkers(web: WebSession): string[] {
  return web.page
    .workers()
    .map(worker => worker.url())
    .filter(url => WORKER.test(new URL(url).pathname))
}

interface Built {
  previewId: string
  buildToPreviewMs: number
  log: string[]
  /** What each time limit said, in order. */
  limits: string[]
  /**
   * For each limit used with no schedule found yet, whether the modal said
   * at once that it waits for the first.
   */
  awaitingFirst: boolean[]
}

/**
 * Taps Build and answers each time limit with `answer` (at most `maxLimits`
 * times) until the preview opens, screenshotting the first limit into
 * `limitShot`, or the first that shows a best schedule.
 */
async function buildAnswering(
  ctx: E2eContext,
  web: WebSession,
  answer: 'Continue processing' | 'Use this schedule' | null,
  options: { maxLimits?: number; limitShot?: string } = {}
): Promise<Built> {
  const maxLimits = options.maxLimits ?? 0
  await web.m.tapOn({ text: 'Build schedule' })
  const tapped = Date.now()
  await web.m.assertVisible({ text: BUILDING, timeout: 10_000 })
  const limits: string[] = []
  const awaitingFirst: boolean[] = []
  let shot = false
  for (;;) {
    const shown = await modalOrPreview(web, [LIMIT_REACHED], 240_000)
    if (shown === PREVIEW_OPEN) break
    if (answer == null || limits.length >= maxLimits)
      throw new Error(`Time limit ${limits.length + 1} reached`)
    const said = (await modalText(web)).find(line => line.startsWith('After '))
    limits.push(said ?? '')
    await ctx.checkpoint(`limit-${limits.length}`, {
      expect: [
        { text: LIMIT_REACHED },
        { text: 'Continue processing' },
        { text: 'Use this schedule' },
        { text: 'Cancel' },
        {
          text: 'After \\d+:\\d\\d the solver hasn’t .*at most [\\d,]+ .*possible\\.'
        }
      ]
    })
    // The first limit, or the first to show a best schedule: HiGHS often
    // has none yet at a short limit.
    if (
      options.limitShot != null &&
      !shot &&
      (limits.length === 1 || said?.includes('Best found') === true)
    ) {
      await web.m.takeScreenshot(options.limitShot)
      shot = said?.includes('Best found') === true
    }
    const lines = (await buildLog(web)).length
    await web.m.tapOn({ text: answer })
    const usedNone = answer === 'Use this schedule' && said?.includes(NONE_YET)
    if (usedNone === true) {
      const text = await modalText(web)
      awaitingFirst.push(
        text.includes(AWAITING_FIRST) &&
          text.some(line => line.endsWith(USING_FIRST))
      )
      if (awaitingFirst.length === 1)
        await web.m.takeScreenshot(ctx.artifact('limit-awaiting-first.png'))
    }
    // The same solve goes on: the modal builds again and its log resumes.
    await ctx.checkpoint(`answered-${limits.length}`, {
      expect: [{ text: BUILDING, timeout: 10_000 }],
      readBack: async () => {
        await eventually(async () => {
          const log = await buildLog(web)
          if (log.length <= lines && (await modalTitle(web)) === BUILDING)
            throw new Error('The log has not resumed')
        }, 60_000)
      }
    })
  }
  const buildToPreviewMs = Date.now() - tapped
  const previewId = await previewRequested(web, RESULT, 10_000)
  return {
    previewId,
    buildToPreviewMs,
    log: await buildLog(web),
    limits,
    awaitingFirst
  }
}

function writeTimings(
  ctx: E2eContext,
  scenario: string,
  built: Built,
  notes: string[] = []
): void {
  writeFileSync(
    ctx.artifact('web-phase-timings.log'),
    phaseTimingsText({
      command: COMMAND(scenario),
      platform: 'web-chromium',
      scenario: `build-modal#${scenario}`,
      buildToPreviewMs: built.buildToPreviewMs,
      lines: built.log,
      notes: [
        ...built.limits.map((said, i) => `Time limit ${i + 1}: ${said}`),
        ...notes
      ]
    })
  )
}

interface Preview {
  status: string
  provenOptimal: boolean
  publishedOption: number | null
  options: Array<{ games: unknown[] }>
}

async function preview(web: WebSession, id: string): Promise<Preview> {
  const read = await apiGet(web, `/schedule-previews/${encodeURIComponent(id)}`)
  expect(read.status, JSON.stringify(read.body)).equals(200)
  return read.body as Preview
}

export default defineE2e({
  id: 'schedule/auto-scheduler/build-modal',
  title:
    'A schedule build shows in a modal with its log, Cancel and the time limit, the Auto-Scheduler offers the previous preview, and a large preview publishes in seconds',
  kind: 'e2e',
  covers: [
    'src/app/components/ScheduleBuildModal.tsx',
    'src/app/scheduling/buildLog.ts',
    'src/app/screens/AutoSchedulerScreen.tsx',
    'src/app/screens/SchedulePreviewScreen.tsx',
    'src/common/scheduler/**',
    'src/server/autoScheduler/**',
    'src/server/groups/rights.ts',
    'src/server/routes/schedulePreviews.ts'
  ],
  stack: 'isolated',
  fixtures: ['packed-league', 'packed-league-limit'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 10,
  guards: [],
  faults: ['api-500', 'blank-screen'],
  manual: false,
  scenarios: {
    'log-and-cancel': async ctx => {
      const { web, league } = await openScheduler(ctx)
      await web.m.tapOn({ text: 'Build schedule' })
      const tapped = Date.now()
      // Each step's line, and the solver's progress, within 10 s.
      await ctx.checkpoint('log-within-10-s', {
        expect: [{ text: BUILDING, timeout: 10_000 }, { text: 'Cancel' }],
        readBack: async () => {
          await eventually(
            async () => {
              const log = await buildLog(web)
              for (const step of [
                'Fields and dates read',
                'Model: ',
                'Games per team settled',
                'Found a schedule with '
              ])
                if (!log.some(line => line.includes(step)))
                  throw new Error(`No "${step}" line yet: ${log.join(' | ')}`)
            },
            Math.max(0, tapped + 10_000 - Date.now())
          )
        }
      })
      await web.m.takeScreenshot(ctx.artifact('scheduler-building-after.png'))
      const log = await buildLog(web)
      const runningWorkers = schedulerWorkers(web)
      await web.m.tapOn({ text: 'Cancel' })
      const canceled = Date.now()
      await ctx.checkpoint('canceled', {
        expect: [
          { text: BUILDING, absent: true, timeout: 10_000 },
          { text: 'Build schedule' }
        ],
        readBack: async () => {
          expect(runningWorkers).lengthOf(1)
          // The worker stops with the build.
          await eventually(async () => {
            expect(schedulerWorkers(web)).deep.equals([])
          }, 10_000)
          // The preparation is discarded on the server.
          const previewId = await previewRequested(web, DISCARD, 10_000)
          const read = await apiGet(
            web,
            `/schedule-previews/${encodeURIComponent(previewId)}`
          )
          expect(read.status).equals(404)
          expect(
            (
              await apiGet(
                web,
                `/leagues/${encodeURIComponent(league)}/schedule-previews/latest`
              )
            ).body
          ).equals(null)
        }
      })
      // Longer than the whole build takes: no preview opens, none is sent.
      await new Promise(resolve => setTimeout(resolve, 20_000))
      await ctx.checkpoint('no-preview', {
        expect: [
          { text: PREVIEW_OPEN, absent: true },
          { text: 'Build schedule' }
        ],
        readBack: async () => {
          expect(await requested(web, RESULT)).deep.equals([])
          expect(await requested(web, PREPARATIONS)).lengthOf(1)
          expect(await modalTitle(web)).equals(null)
        }
      })
      writeFileSync(
        ctx.artifact('web-phase-timings.log'),
        [
          `$ ${COMMAND('log-and-cancel')}`,
          `# web-chromium, build-modal#log-and-cancel, ${new Date().toISOString()}`,
          `Canceled ${((canceled - tapped) / 1000).toFixed(1)} s after Build; the log until then:`,
          ...log.map(line => `  ${line}`),
          ''
        ].join('\n')
      )
    },

    'limit-continue': async ctx => {
      const { web } = await openScheduler(ctx, {
        world: 'packed-league-limit',
        beforeLoad: WORLD_LIMIT
      })
      const built = await buildAnswering(ctx, web, 'Continue processing', {
        maxLimits: 10,
        limitShot: ctx.artifact('limit-reached.png')
      })
      const sent = await sentLimits(web)
      writeTimings(ctx, 'limit-continue', built, [
        `Continue processing tapped ${built.limits.length} times`,
        `Solver limit: the server sent ${sent.join(', ')} ms; the build ran with ${WORLD_LIMIT_MS} ms`
      ])
      await ctx.checkpoint('proven', {
        expect: SHORT_SEASON_LINES.map(text => ({ text, timeout: 30_000 })),
        readBack: async () => {
          expect(sent).lengthOf(1)
          expect(built.limits.length).greaterThan(0)
          expect(built.log.some(line => line.includes('Games placed'))).equals(
            true
          )
          expect((await preview(web, built.previewId)).provenOptimal).equals(
            true
          )
          expectExactCounts(await countsShown(web))
        }
      })
    },

    'limit-accept': async ctx => {
      const { web } = await openScheduler(ctx, {
        world: 'packed-league-limit',
        beforeLoad: WORLD_LIMIT
      })
      const built = await buildAnswering(ctx, web, 'Use this schedule', {
        maxLimits: 2
      })
      const sent = await sentLimits(web)
      writeTimings(ctx, 'limit-accept', built, [
        `Use this schedule tapped ${built.limits.length} times`,
        ...built.awaitingFirst.map(
          (said, i) =>
            `Used with no schedule yet (${i + 1}): the modal ${said ? 'said' : 'did not say'} it waits for the first`
        ),
        `Solver limit: the server sent ${sent.join(', ')} ms; the build ran with ${WORLD_LIMIT_MS} ms`
      ])
      await web.m.scrollUntilVisible({ element: { text: TIME_LIMIT_LINE } })
      await web.m.takeScreenshot(ctx.artifact('limit-accepted-preview.png'))
      const stored = await preview(web, built.previewId)
      // The best the modal showed at the last limit it was answered at.
      const best = /Best found: ([\d,]+) games/.exec(built.limits.at(-1) ?? '')
      await ctx.checkpoint('not-proven', {
        expect: [{ text: TIME_LIMIT_LINE }],
        readBack: async () => {
          expect(built.limits.length).greaterThan(0)
          // A limit with none found yet uses the first, and says so.
          expect(built.awaitingFirst.every(said => said)).equals(true)
          expect(
            built.log.filter(line => line.endsWith(USING_FIRST)).length
          ).equals(built.awaitingFirst.length)
          expect(stored.provenOptimal).equals(false)
          expect(stored.status).equals('open')
          if (best != null)
            expect(stored.options[0].games.length).equals(
              Number(best[1].replace(/,/g, ''))
            )
          // Short seasons each say they stopped at the limit.
          const text = await bodyText(web)
          expect(text.split(TIME_LIMIT_LINE).length - 1).greaterThan(0)
        }
      })
    },

    'no-solver': async ctx => {
      const { web, league } = await openScheduler(ctx, {
        beforeLoad: `Object.defineProperty(globalThis, 'WebAssembly', { value: undefined, configurable: true })`
      })
      await web.m.tapOn({ text: 'Build schedule' })
      await ctx.checkpoint('no-solver', {
        expect: [
          { text: NO_SOLVER, timeout: 60_000 },
          { text: '.*This browser has no WebAssembly.*' },
          { text: 'Close' }
        ],
        readBack: async () => {
          expect(await requested(web, MODULE)).deep.equals([])
          expect(await requested(web, RESULT)).deep.equals([])
          // No preview was made.
          expect(
            (
              await apiGet(
                web,
                `/leagues/${encodeURIComponent(league)}/schedule-previews/latest`
              )
            ).body
          ).equals(null)
        }
      })
      await web.m.takeScreenshot(ctx.artifact('no-solver.png'))
      await web.m.tapOn({ text: 'Close' })
      await ctx.checkpoint('closed', {
        expect: [
          { text: NO_SOLVER, absent: true, timeout: 10_000 },
          { text: 'Build schedule' }
        ]
      })
    },

    'previous-preview': async ctx => {
      const { web } = await openScheduler(ctx)
      const built = await buildAnswering(ctx, web, null)
      writeTimings(ctx, 'previous-preview', built)
      await web.m.back()
      await ctx.checkpoint('previous-preview-button', {
        expect: [
          { text: 'Show previous schedule preview', timeout: 30_000 },
          { text: 'Built .*' },
          { text: 'Build schedule' }
        ],
        readBack: async () => {
          // The button sits above Build schedule.
          const tops = await web.page.evaluate(() => {
            const top = (label: string): number | null => {
              const found = [...document.querySelectorAll('[role="button"]')]
                .filter(element => (element as HTMLElement).innerText === label)
                .map(element => element.getBoundingClientRect().top)
              // Plain JavaScript: the page runs this as written.
              return found.length > 0 ? found[0] : null
            }
            return {
              previous: top('Show previous schedule preview'),
              build: top('Build schedule')
            }
          })
          expect(tops.previous).not.equals(null)
          expect(tops.build).not.equals(null)
          expect(tops.previous ?? 0).lessThan(tops.build ?? 0)
        }
      })
      await web.m.scrollUntilVisible({
        element: { text: 'Show previous schedule preview' },
        centerElement: true
      })
      await web.m.takeScreenshot(ctx.artifact('previous-preview-button.png'))
      await web.m.tapOn({ text: 'Show previous schedule preview' })
      await ctx.checkpoint('same-preview', {
        expect: [{ text: PREVIEW_OPEN, timeout: 30_000 }],
        readBack: async () => {
          expect(decodeURIComponent(web.page.url())).includes(
            `/previews/${built.previewId}`
          )
        }
      })
    },

    publish: async ctx => {
      const { web } = await openScheduler(ctx)
      const built = await buildAnswering(ctx, web, null)
      // The Fairness tab is short, so Publish is near.
      await web.m.tapOn({ text: 'Fairness' })
      await web.m.scrollUntilVisible({
        element: { text: 'Publish this option' }
      })
      await web.m.tapOn({ text: 'Publish this option' })
      const tapped = Date.now()
      // Waited for longer than the bound, so a slow publish shows its time.
      await firstShown(web, ['338 games scheduled.'], 300_000)
      const publishMs = Date.now() - tapped
      // The publish request's own time, from the page's resource timing.
      const requestMs = await web.page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .filter(entry => entry.name.endsWith('/publications'))
          .map(entry => Math.round(entry.duration))
      )
      writeTimings(ctx, 'publish', built, [
        `Publish to "338 games scheduled.": ${(publishMs / 1000).toFixed(1)} s (the publish request: ${requestMs.join(', ')} ms)`
      ])
      await ctx.checkpoint('published', {
        expect: [{ text: '338 games scheduled.' }],
        readBack: async () => {
          expect(publishMs).lessThan(PUBLISH_BOUND_MS)
          const stored = await preview(web, built.previewId)
          expect(stored.status).equals('published')
          expect(stored.options[stored.publishedOption ?? -1].games).lengthOf(
            338
          )
        }
      })
    }
  }
})
