import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'

import {
  defineHarness,
  type HarnessContext,
  type WebSession
} from '../../../core/spec'
import {
  bodyText,
  BUILDING,
  buildLog,
  countsShown,
  expectExactCounts,
  firstShown,
  logBox,
  MODULE,
  NO_SOLVER,
  openScheduler,
  phaseTimingsText,
  PREVIEW_OPEN,
  previewRequested,
  recordPage,
  requested,
  RESULT,
  RUNNING_LINE,
  SHORT_SEASON_LINES,
  warnings,
  WORKER
} from '../../../rigs/schedule/autoScheduler'

/**
 * The Auto-Scheduler on the web builds the packed league (the `packed-league`
 * world) at its exact counts, in the build modal, with the engine's
 * WebAssembly fetched only when Build is tapped: S1 10, S2 10, S3 12, S4 14,
 * S5 16 and S6 16 games per team, S5 held by field time and S6 by its weekly
 * maximums. Without WebAssembly, or with a module that is not the one built,
 * the modal says the device can't run the scheduler, and nothing is built.
 */

const COMMAND = (scenario: string): string =>
  `(teamstation-devops) npm run e2e -- run <ts>/e2e/tests/schedule/auto-scheduler/exact-counts.e2e.ts --scenario ${scenario} --surface web-chromium`

/** Builds in the modal and waits for the preview: Build to preview, in ms. */
async function build(web: WebSession): Promise<number> {
  await web.m.tapOn({ text: 'Build schedule' })
  const tapped = Date.now()
  await web.m.assertVisible({ text: BUILDING, timeout: 10_000 })
  await firstShown(web, [PREVIEW_OPEN], 180_000)
  return Date.now() - tapped
}

/** Taps Build on a page that cannot run the engine, and waits for it to say so. */
async function buildRefused(web: WebSession, reason: string): Promise<void> {
  await web.m.tapOn({ text: 'Build schedule' })
  await web.m.assertVisible({ text: NO_SOLVER, timeout: 60_000 })
  await web.m.assertVisible({ text: `.*${reason}.*` })
}

/** What a run without the engine saw, for `web-no-solver-<scenario>.log`. */
async function noSolverLog(
  ctx: HarnessContext,
  web: WebSession,
  scenario: string
): Promise<void> {
  const worker = await requested(web, WORKER)
  const module = await requested(web, MODULE)
  writeFileSync(
    ctx.artifact(`web-no-solver-${scenario}.log`),
    [
      `$ ${COMMAND(scenario)}`,
      `console warnings: ${JSON.stringify(await warnings(web))}`,
      `worker requests: ${worker.length}`,
      ...worker,
      `module requests: ${module.length}`,
      ...module,
      `result requests: ${(await requested(web, RESULT)).length}`,
      ''
    ].join('\n')
  )
}

export default defineHarness({
  id: 'schedule/auto-scheduler/exact-counts',
  title:
    'The Auto-Scheduler builds a packed league at its exact counts on the web, fetching its engine only on Build and telling a browser that cannot run it so',
  kind: 'e2e',
  covers: [
    'src/common/autoScheduler/**',
    'src/common/scheduler/**',
    'src/app/platform/schedulerWorker.ts',
    'src/app/components/ScheduleBuildModal.tsx',
    'src/build.mjs'
  ],
  stack: 'isolated',
  fixtures: ['packed-league'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 10,
  guards: [],
  faults: ['api-500', 'blank-screen'],
  manual: false,
  scenarios: {
    'packed-league': async ctx => {
      const { web } = await openScheduler(ctx)
      const before = [
        ...(await requested(web, WORKER)),
        ...(await requested(web, MODULE))
      ]
      await ctx.checkpoint('no-solver-before-build', {
        readBack: async () => {
          expect(before).deep.equals([])
        }
      })
      // The page's own recording of the build, where the browser can make one.
      const recording = await recordPage(
        web,
        ctx.artifact('web-build.mp4'),
        join(ctx.runDir, 'scratch')
      ).catch((error: unknown) => {
        writeFileSync(
          ctx.artifact('web-build-recording.log'),
          `No recording: ${String(error)}\n`
        )
        return null
      })
      let tapped = 0
      let buildToPreviewMs = 0
      let opened: Awaited<ReturnType<typeof logBox>> = null
      const reads: Array<NonNullable<Awaited<ReturnType<typeof logBox>>>> = []
      // The recording stops however the build ends, a failing one most of
      // all: one that can't be put together is noted, as one that can't
      // start is.
      try {
        await web.m.tapOn({ text: 'Build schedule' })
        tapped = Date.now()
        // The worker solves off the page's thread, so the page still answers
        // while the modal logs the build.
        await ctx.checkpoint('responsive-during-build', {
          expect: [{ text: BUILDING, timeout: 10_000 }, { text: 'Cancel' }],
          readBack: async () => {
            const started = Date.now()
            const text = await bodyText(web)
            expect(text).includes(BUILDING)
            expect(Date.now() - started).lessThan(1_000)
          }
        })
        // The box, four lines high from the start, logs like a terminal: the
        // first line on its bottom row, and a running step's clock ticking.
        opened = await logBox(web)
        await web.m.takeScreenshot(ctx.artifact('web-modal-opened.png'))
        let runningShot = false
        // Until the modal closes on the preview, within the build's three
        // minutes; a modal that stops building (a failure, no solver, a time
        // limit) fails here, with the last box read.
        const deadline = tapped + 180_000
        for (;;) {
          const box = await logBox(web)
          if (box == null) break
          reads.push(box)
          const stopped =
            box.heading != null &&
            box.heading.toLowerCase() !== BUILDING.toLowerCase()
          if (stopped || Date.now() > deadline)
            throw new Error(
              `${stopped ? `The build modal says “${box.heading}”` : 'The build modal was still open after 3 minutes'}; its box: ${box.lines.join(' | ')}`
            )
          const running = box.lines.findIndex(line => RUNNING_LINE.test(line))
          if (
            !runningShot &&
            running >= 0 &&
            box.lines
              .slice(running + 1)
              .some(line => line.includes('Found a schedule with'))
          ) {
            await web.m.takeScreenshot(ctx.artifact('web-modal-running.png'))
            runningShot = true
          }
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        await firstShown(
          web,
          [PREVIEW_OPEN],
          Math.max(10_000, deadline - Date.now())
        )
        buildToPreviewMs = Date.now() - tapped
      } finally {
        await recording?.stop().catch((error: unknown) => {
          writeFileSync(
            ctx.artifact('web-build-recording.log'),
            `No recording: ${String(error)}\n`
          )
        })
      }
      await ctx.checkpoint('terminal-log', {
        readBack: async () => {
          expect(opened, 'the box at once').not.equals(null)
          if (opened == null) return
          // The same height throughout: it never grows.
          for (const read of reads) expect(read.height).equals(opened.height)
          expect(opened.height).greaterThan(0)
          // Each step's clock ticks: one running line read at two seconds.
          const clocks = new Map<string, Set<string>>()
          for (const read of reads)
            for (const line of read.lines) {
              const match = RUNNING_LINE.exec(line)
              if (match == null) continue
              const seen = clocks.get(match[3]) ?? new Set<string>()
              seen.add(`${match[1]}:${match[2]}`)
              clocks.set(match[3], seen)
            }
          expect(
            [...clocks.values()].some(seen => seen.size >= 2),
            `a running line ticking: ${JSON.stringify([...clocks].map(([step, seen]) => [step, [...seen]]))}`
          ).equals(true)
          // A line's first read sits on the box's bottom row, or above it
          // once more have come: never at the top of an empty box.
          const first = reads.find(read => read.lines.length === 1)
          if (first?.firstLineTop != null)
            expect(first.firstLineTop).greaterThan(first.height / 2)
          writeFileSync(
            ctx.artifact('web-log-box-reads.log'),
            [
              `The box, ${opened.height} px high, read every 0.2 s from the modal opening (px scrolled up from its foot: lines):`,
              ...reads.map(
                read => `  ${read.fromFoot}: ${read.lines.join(' | ')}`
              ),
              ''
            ].join('\n')
          )
        }
      })
      const previewId = await previewRequested(web, RESULT, 10_000)
      const after = [
        ...(await requested(web, WORKER)),
        ...(await requested(web, MODULE))
      ]
      const warned = await warnings(web)
      writeFileSync(
        ctx.artifact('web-network-on-demand.log'),
        [
          `$ ${COMMAND('packed-league')}`,
          `solver requests before Build: ${before.length}`,
          ...before,
          `solver requests after Build: ${after.length}`,
          ...after,
          ''
        ].join('\n')
      )
      writeFileSync(
        ctx.artifact('web-phase-timings.log'),
        phaseTimingsText({
          command: COMMAND('packed-league'),
          platform: 'web-chromium',
          scenario: 'exact-counts#packed-league',
          buildToPreviewMs,
          lines: await buildLog(web),
          notes: [`Preview ${previewId}`]
        })
      )
      await ctx.checkpoint('one-solver-after-build', {
        readBack: async () => {
          expect(
            after.filter(name => WORKER.test(new URL(name).pathname))
          ).lengthOf(1)
          expect(
            after.filter(name => MODULE.test(new URL(name).pathname))
          ).lengthOf(1)
          expect(warned).deep.equals([])
        }
      })
      await web.m.takeScreenshot(ctx.artifact('preview-after.png'))
      await ctx.checkpoint('preview-counts', {
        expect: SHORT_SEASON_LINES.map(text => ({ text })),
        readBack: async () => {
          expectExactCounts(await countsShown(web))
        }
      })
    },

    'no-webassembly': async ctx => {
      const { web } = await openScheduler(ctx, {
        beforeLoad: `Object.defineProperty(globalThis, 'WebAssembly', { value: undefined, configurable: true })`
      })
      await buildRefused(web, 'This browser has no WebAssembly')
      await ctx.checkpoint('no-solver', {
        expect: [
          { text: NO_SOLVER },
          { text: '.*This browser has no WebAssembly.*' },
          { text: 'Close' }
        ],
        readBack: async () => {
          expect(await requested(web, MODULE)).deep.equals([])
          // The tab's document cache is SQLite on WebAssembly too: without
          // it the session runs uncached and says so (#358).
          expect(await warnings(web)).to.have.members([
            'Offline document cache unavailable: Error: This browser has no WebAssembly',
            'scheduler unavailable: noWebAssembly'
          ])
          // Nothing was built, so no result was sent.
          expect(await requested(web, RESULT)).deep.equals([])
          await noSolverLog(ctx, web, 'no-webassembly')
        }
      })
    },

    'tampered-module': async ctx => {
      const { web } = await openScheduler(ctx, {
        beforeLoad: `
        const fetchFirst = window.fetch.bind(window)
        window.fetch = async (input, init) => {
          const url = String(input && input.url ? input.url : input)
          if (!/\\/scheduler-[0-9a-f]+\\.wasm$/.test(new URL(url, location.href).pathname))
            return await fetchFirst(input, init)
          const real = await fetchFirst(input)
          const bytes = new Uint8Array(await real.arrayBuffer())
          bytes[bytes.length - 1] ^= 0xff
          return new Response(bytes, { status: 200 })
        }
      `
      })
      await buildRefused(web, 'not the one this page was built with')
      await ctx.checkpoint('no-solver', {
        expect: [
          { text: NO_SOLVER },
          { text: '.*not the one this page was built with.*' }
        ],
        readBack: async () => {
          expect(await warnings(web)).deep.equals([
            'scheduler unavailable: integrity'
          ])
          expect(await requested(web, MODULE)).lengthOf(1)
          expect(await requested(web, WORKER)).deep.equals([])
          expect(await requested(web, RESULT)).deep.equals([])
          await noSolverLog(ctx, web, 'tampered-module')
        }
      })
    },

    'worker-reuse': async ctx => {
      const { web } = await openScheduler(ctx)
      const first = await build(web)
      const firstCounts = await countsShown(web)
      // Back to the Auto-Scheduler in the same page, and build again.
      await web.m.back()
      await web.m.assertVisible({ text: 'Build schedule', timeout: 30_000 })
      const second = await build(web)
      writeFileSync(
        ctx.artifact('web-phase-timings.log'),
        [
          `$ ${COMMAND('worker-reuse')}`,
          `Build to preview: first ${(first / 1000).toFixed(1)} s, second ${(second / 1000).toFixed(1)} s (the same worker and module)`,
          ''
        ].join('\n')
      )
      await ctx.checkpoint('reused', {
        expect: SHORT_SEASON_LINES.map(text => ({ text })),
        readBack: async () => {
          expect(await requested(web, WORKER)).lengthOf(1)
          expect(await requested(web, MODULE)).lengthOf(1)
          expectExactCounts(firstCounts)
          expect(await countsShown(web)).deep.equals(firstCounts)
        }
      })
    }
  }
})
