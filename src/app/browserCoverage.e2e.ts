import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

import type { Page } from 'puppeteer'

/** Convert the actual browser's executed bundle ranges to original application files. */
export async function recordBrowserCoverage(
  pages: Page[],
  origin: string,
  output: string,
  sourceMapRoot = resolve('dist')
): Promise<void> {
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
  const createCoverageMap = require('istanbul-lib-coverage')
    .createCoverageMap as (value: unknown) => {
    merge: (value: unknown) => void
    toJSON: () => unknown
  }
  const coverage = createCoverageMap({})
  for (const page of pages) {
    for (const script of await page.coverage.stopJSCoverage()) {
      if (
        !script.url.startsWith(origin + '/app-') ||
        script.rawScriptCoverage == null
      )
        continue
      const generated = resolve('dist', basename(new URL(script.url).pathname))
      const converter = convert(generated, 0, {
        source: script.text,
        sourceMap: {
          sourcemap: JSON.parse(
            await readFile(
              resolve(sourceMapRoot, basename(generated) + '.map'),
              'utf8'
            )
          )
        }
      })
      await converter.load()
      converter.applyCoverage(script.rawScriptCoverage.functions)
      coverage.merge(converter.toIstanbul())
    }
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(coverage.toJSON()))
}

/**
 * Counts JS coverage on every page a harness opens, across the pages it
 * closes, for one `recordBrowserCoverage` at the end. A page's counts are
 * taken as it closes, and its bundle text is kept once per script URL.
 */
export function browserCoverageCollector(origin: string): {
  track: (page: Page) => Promise<void>
  record: (output: string) => Promise<void>
} {
  type Entry = Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>[number]
  const texts = new Map<string, string>()
  const entries: Entry[] = []
  const counting = new Set<Page>()
  const stop = async (page: Page): Promise<void> => {
    if (!counting.delete(page)) return
    for (const entry of await page.coverage.stopJSCoverage()) {
      if (!entry.url.startsWith(origin + '/app-')) continue
      const text = texts.get(entry.url) ?? entry.text
      texts.set(entry.url, text)
      entries.push({ ...entry, text })
    }
  }
  return {
    track: async page => {
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
      counting.add(page)
      const close = page.close.bind(page)
      page.close = async options => {
        await stop(page).catch(() => undefined)
        await close(options)
      }
    },
    record: async output => {
      for (const page of [...counting]) await stop(page).catch(() => undefined)
      const counted = {
        coverage: { stopJSCoverage: async () => await Promise.resolve(entries) }
      } as unknown as Page
      await recordBrowserCoverage([counted], origin, output)
    }
  }
}
