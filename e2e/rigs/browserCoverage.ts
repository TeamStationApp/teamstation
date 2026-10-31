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
