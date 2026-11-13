import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

import type { Browser, CDPSession, Page } from 'puppeteer'

/**
 * V8 coverage of the web app in a real browser, its pages and its service
 * worker alike, mapped to the sources through the build's source maps (as
 * `browserCoverage.e2e.ts` maps the pages').
 *
 * The browser must be launched with `browserLaunchOptions`: Puppeteer then
 * leaves service workers to this session, which attaches to each one as it
 * starts, while it waits for a debugger, and starts V8's precise coverage
 * before the script runs. Chrome's eager code cache is off, since a script
 * compiled from it before the profiler started reports no counters at all.
 *
 * v8-to-istanbul counts a line as run unless a range says it was not, so
 * only a report holding the bundle's own function (whose count-0 blocks are
 * the code that never ran) can be mapped. V8 sometimes compiles a worker's
 * script before the profiler is on, and a page's earlier document can lose
 * that function too; `counted` says whether the worker running now was
 * measured from its start, so a test can restart it until it is, and
 * `record` adds every other report's counts into a whole one of the same
 * script, and refuses a script that has none.
 */

/** Puppeteer's launch options that leave service workers to this. */
export const browserLaunchOptions = {
  targetFilter: (target: { type: () => string }) =>
    target.type() !== 'service_worker',
  args: ['--disable-features=ServiceWorkerEagerCodeCache']
}

interface ScriptCoverage {
  url: string
  functions: Array<{
    functionName: string
    isBlockCoverage: boolean
    ranges: Array<{ startOffset: number; endOffset: number; count: number }>
  }>
}

interface Worker {
  session: CDPSession
  url: string
  /** Each `takePreciseCoverage` taken of it: counts since the one before. */
  samples: ScriptCoverage[][]
  closed: boolean
}

/** The bundle's own function: its first range spans nearly the whole script. */
function spansScript(script: ScriptCoverage, length: number): boolean {
  return script.functions.some(
    fn =>
      fn.ranges[0].startOffset <= 64 && fn.ranges[0].endOffset >= length - 64
  )
}

/**
 * Adds `extra`'s counts into `base`, a report of the same script: a range
 * both have adds up, and a function or block only `extra` reports (compiled
 * after `base` was taken) is added after those `base` has.
 */
function fold(base: ScriptCoverage, extra: ScriptCoverage): void {
  const key = (range: { startOffset: number; endOffset: number }): string =>
    `${range.startOffset}:${range.endOffset}`
  const functions = new Map(base.functions.map(fn => [key(fn.ranges[0]), fn]))
  for (const fn of extra.functions) {
    const held = functions.get(key(fn.ranges[0]))
    if (held == null) {
      const added = structuredClone(fn)
      base.functions.push(added)
      functions.set(key(fn.ranges[0]), added)
      continue
    }
    const ranges = new Map(held.ranges.map(range => [key(range), range]))
    for (const range of fn.ranges) {
      const same = ranges.get(key(range))
      if (same != null) same.count += range.count
      else held.ranges.push({ ...range })
    }
  }
}

export interface WebCoverage {
  /** Counts `page`'s scripts until it closes or `record` runs. */
  track: (page: Page) => Promise<void>
  /** The service workers running now, as `Runtime.evaluate` reaches them. */
  workers: () => CDPSession[]
  /** Whether the newest worker for `scriptUrl` was measured from its start. */
  counted: (scriptUrl: string) => Promise<boolean>
  /** Writes the istanbul coverage of every script `served` holds a map for. */
  record: (output: string) => Promise<void>
}

/**
 * Attaches to `browser`'s service workers, and with `measure` counts what
 * they and the tracked pages run. `served` is the directory the web app is
 * served from, which holds each script and its `.map`; `origin` its address.
 */
export async function webCoverage(
  browser: Browser,
  options: { origin: string; served: string; measure: boolean }
): Promise<WebCoverage> {
  const root = await browser.target().createCDPSession()
  const workers: Worker[] = []
  root.on('sessionattached', (session: CDPSession) => {
    const worker: Worker = {
      session,
      url: '',
      samples: [],
      closed: false
    }
    workers.push(worker)
    session.once('sessiondetached', () => {
      worker.closed = true
    })
    // What goes wrong in a worker shows nowhere else.
    session.on('Runtime.exceptionThrown', event => {
      console.error(
        'service worker:',
        event.exceptionDetails.exception?.description ??
          event.exceptionDetails.text
      )
    })
    const start = async (): Promise<void> => {
      await session.send('Runtime.enable')
      if (options.measure) {
        await session.send('Profiler.enable')
        await session.send('Profiler.startPreciseCoverage', {
          callCount: true,
          detailed: true
        })
        await session.send('Debugger.enable')
        await session.send('Debugger.setSkipAllPauses', { skip: true })
      }
    }
    start()
      .catch(() => undefined)
      .finally(() => {
        session.send('Runtime.runIfWaitingForDebugger').catch(() => undefined)
      })
  })
  await root.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: 'service_worker', exclude: false }, { exclude: true }]
  })

  /** The script a worker runs, asked once it is running. */
  const urlOf = async (worker: Worker): Promise<string> => {
    if (worker.url === '' && !worker.closed) {
      const { result } = await worker.session
        .send('Runtime.evaluate', {
          expression: 'self.location.href',
          returnByValue: true
        })
        .catch(() => ({ result: { value: '' } }))
      worker.url = typeof result.value === 'string' ? result.value : ''
    }
    return worker.url
  }

  /** Takes what a live worker counted since its last sample. */
  const sample = async (worker: Worker): Promise<void> => {
    if (worker.closed || !options.measure) return
    try {
      const { result } = await worker.session.send(
        'Profiler.takePreciseCoverage'
      )
      worker.samples.push(result)
    } catch {
      worker.closed = true
    }
  }

  const pages = new Set<Page>()
  const entries: ScriptCoverage[] = []
  const texts = new Map<string, string>()
  const stop = async (page: Page): Promise<void> => {
    if (!pages.delete(page)) return
    for (const entry of await page.coverage.stopJSCoverage()) {
      if (entry.rawScriptCoverage == null) continue
      texts.set(entry.url, entry.text)
      entries.push({
        url: entry.url,
        functions: entry.rawScriptCoverage.functions
      })
    }
  }

  /** The served file a script URL of this origin is, if it is one. */
  const servedFile = (url: string): string | undefined => {
    if (!url.startsWith(options.origin + '/')) return undefined
    const name = basename(new URL(url).pathname)
    return /^(app(-[A-Z0-9]+)?|sw)\.js$/i.test(name)
      ? resolve(options.served, name)
      : undefined
  }
  const textOf = async (url: string): Promise<string> =>
    texts.get(url) ?? (await readFile(servedFile(url)!, 'utf8'))

  return {
    track: async page => {
      if (!options.measure) return
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
      pages.add(page)
      const close = page.close.bind(page)
      page.close = async closing => {
        await stop(page).catch(() => undefined)
        await close(closing)
      }
    },
    workers: () =>
      workers.filter(worker => !worker.closed).map(worker => worker.session),
    counted: async scriptUrl => {
      for (const held of workers) await urlOf(held)
      const worker = workers
        .filter(held => !held.closed && held.url === scriptUrl)
        .at(-1)
      if (!options.measure) return true
      if (worker == null) return false
      await sample(worker)
      const length = (await textOf(scriptUrl)).length
      return worker.samples.some(taken =>
        taken.some(
          script => script.url === scriptUrl && spansScript(script, length)
        )
      )
    },
    record: async output => {
      if (!options.measure) return
      for (const page of [...pages]) await stop(page).catch(() => undefined)
      for (const worker of workers) await sample(worker)
      const require = createRequire(resolve('package.json'))
      const convert = require('v8-to-istanbul') as (
        file: string,
        offset: number,
        sources: unknown
      ) => {
        load: () => Promise<void>
        applyCoverage: (functions: unknown) => void
        toIstanbul: () => Record<string, unknown>
      }
      const coverage = (
        require('istanbul-lib-coverage').createCoverageMap as (
          value: unknown
        ) => { merge: (value: unknown) => void; toJSON: () => unknown }
      )({})
      const add = async (script: ScriptCoverage): Promise<void> => {
        const file = servedFile(script.url)
        if (file == null) return
        const converter = convert(file, 0, {
          source: await textOf(script.url),
          sourceMap: {
            sourcemap: JSON.parse(await readFile(file + '.map', 'utf8'))
          }
        })
        await converter.load()
        converter.applyCoverage(script.functions)
        coverage.merge(converter.toIstanbul())
      }
      // Every report of one script, its pages' and its workers' samples
      // alike, is folded into one before mapping. Only a report with the
      // bundle's own range says which of its lines did not run, through the
      // count-0 blocks under it; any other (a sample after the first, or a
      // page's earlier document) only adds counts to it.
      const reports = [
        ...entries,
        ...workers.flatMap(worker => worker.samples.flat())
      ]
      const folded = new Map<string, ScriptCoverage>()
      const bases = new Set<ScriptCoverage>()
      for (const report of reports) {
        if (servedFile(report.url) == null || folded.has(report.url)) continue
        if (!spansScript(report, (await textOf(report.url)).length)) continue
        folded.set(report.url, structuredClone(report))
        bases.add(report)
      }
      for (const report of reports) {
        const base = folded.get(report.url)
        if (base != null && !bases.has(report)) fold(base, report)
      }
      for (const url of [...new Set(reports.map(report => report.url))].filter(
        url => servedFile(url) != null
      ))
        if (!folded.has(url))
          throw new Error(`${url} was not measured from its start`)
      for (const script of folded.values()) await add(script)
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, JSON.stringify(coverage.toJSON()))
    }
  }
}
