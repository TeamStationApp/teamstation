import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { recordBrowserCoverage } from '../rigs/browserCoverage'
import type { BrowserPage } from './browserCdp'

/**
 * What a run's browser executed, for the coverage scripts. Each scenario writes its
 * own istanbul map, and `e2e coverage-merge` joins a directory of them into the one file
 * those scripts read, such as `TS_DIRECT_BROWSER_COVERAGE`.
 */
export async function startCoverage(page: BrowserPage): Promise<void> {
  await page.coverage.startJSCoverage({
    includeRawScriptCoverage: true,
    resetOnNavigation: false
  })
}

export function coverageFile(
  dir: string,
  scenarioId: string,
  index: number
): string {
  return join(dir, `${scenarioId.replace(/[^\w-]+/g, '_')}-${index}.json`)
}

export async function writeCoverage(
  pages: BrowserPage[],
  webDir: string,
  origin: string,
  output: string
): Promise<void> {
  await recordBrowserCoverage(pages, origin, output, webDir)
}

/** Joins every map in a directory, so scenarios run apart add up. */
export function mergeCoverage(dir: string, output: string): number {
  const require = createRequire(resolve('package.json'))
  const { createCoverageMap } = require('istanbul-lib-coverage') as {
    createCoverageMap: (value: unknown) => {
      merge: (value: unknown) => void
      toJSON: () => unknown
    }
  }
  const merged = createCoverageMap({})
  const files = readdirSync(dir).filter(name => name.endsWith('.json'))
  for (const file of files) {
    merged.merge(JSON.parse(readFileSync(join(dir, file), 'utf8')))
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(merged.toJSON()))
  return files.length
}
