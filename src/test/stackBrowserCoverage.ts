import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

import type { Page } from 'puppeteer'

/**
 * Writes the browser's counters for the app bundle as an istanbul map, the
 * shape `scripts/ui-tweaks-coverage.mjs` merges through
 * `TS_DIRECT_BROWSER_COVERAGE`.
 *
 * The coverage was started by `browserSession` on this same connection; this
 * only stops it and converts. The served bundle must be the local `dist`
 * build byte for byte, and every source in its map must still be the file on
 * disk, or the counters would describe code that is not the code measured.
 */
export async function stackBrowserCoverage(
  page: Page,
  origin: string,
  output: string,
  tests: number
): Promise<void> {
  const convert = require('v8-to-istanbul')
  const merged: Record<string, unknown> = {}
  let bundles = 0
  for (const script of await page.coverage.stopJSCoverage()) {
    if (
      !script.url.startsWith(origin + '/app') ||
      !/\/app(?:-[\w-]+)?\.js$/.test(new URL(script.url).pathname)
    )
      continue
    if (script.rawScriptCoverage == null)
      throw new Error('Missing raw browser counters')
    const generated = resolve('dist', basename(new URL(script.url).pathname))
    if ((await readFile(generated, 'utf8')) !== script.text)
      throw new Error('Browser bundle differs from the local measured build')
    const map = JSON.parse(await readFile(generated + '.map', 'utf8'))
    for (let i = 0; i < map.sources.length; i++) {
      const file = resolve('dist', map.sourceRoot ?? '', map.sources[i])
      if (!relative(process.cwd(), file).startsWith('src/')) continue
      if ((await readFile(file, 'utf8')) !== map.sourcesContent?.[i])
        throw new Error(
          `Stale browser source: ${relative(process.cwd(), file)}`
        )
    }
    const converter = convert(generated, 0, {
      source: script.text,
      sourceMap: { sourcemap: map }
    })
    await converter.load()
    converter.applyCoverage(script.rawScriptCoverage.functions)
    for (const [file, coverage] of Object.entries(
      converter.toIstanbul() as Record<string, { path: string }>
    )) {
      const path = isAbsolute(file) ? file : resolve(file)
      if (!relative(process.cwd(), path).startsWith('src/')) continue
      merged[path] = { ...coverage, path }
    }
    bundles++
  }
  if (bundles === 0 || tests < 1)
    throw new Error('No verified browser scenario or mapped app bundle')
  await writeFile(output, JSON.stringify(merged))
}
