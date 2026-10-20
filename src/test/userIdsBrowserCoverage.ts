import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

import type { Page } from 'puppeteer'

const { digest, readCounters } = require('../../scripts/user-id-coverage.cjs')

/** Export the same Chromium connection's counters, checking the exact bundle and sources. */
export async function userIdsBrowserCoverage(
  page: Page,
  origin: string,
  output: string,
  tests: number
): Promise<void> {
  const base = process.env.TS_COVERAGE_BASE
  if (base == null) throw new Error('Supply the pinned TS_COVERAGE_BASE')
  const git = (...args: string[]): string =>
    execFileSync('git', args, { encoding: 'utf8' }).trim()
  const counts: Record<string, Record<string, number>> = {}
  const hashes: Record<string, string> = {}
  const convert = require('v8-to-istanbul')
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
    if (
      !Array.isArray(map.sourcesContent) ||
      map.sourcesContent.length !== map.sources.length
    )
      throw new Error('Browser source map is incomplete')
    for (let i = 0; i < map.sources.length; i++) {
      const file = resolve('dist', map.sourceRoot ?? '', map.sources[i])
      const name = relative(process.cwd(), file)
      if (!name.startsWith('src/')) continue
      if ((await readFile(file, 'utf8')) !== map.sourcesContent[i])
        throw new Error(`Stale browser source: ${name}`)
      hashes[name] = digest(file)
    }
    const converter = convert(generated, 0, {
      source: script.text,
      sourceMap: { sourcemap: map }
    })
    await converter.load()
    converter.applyCoverage(script.rawScriptCoverage.functions)
    const raw: Record<string, Record<string, number>> = readCounters(
      'istanbul',
      JSON.stringify(converter.toIstanbul())
    )
    for (const [file, lines] of Object.entries(raw)) {
      const name = isAbsolute(file) ? relative(process.cwd(), file) : file
      if (!(name in hashes)) continue
      const held = (counts[name] ??= {})
      for (const [line, hits] of Object.entries(lines))
        held[line] = Math.max(held[line] ?? 0, hits)
    }
    bundles++
  }
  if (bundles === 0 || tests < 1)
    throw new Error('No verified browser scenario or mapped app bundle')
  await writeFile(
    output,
    JSON.stringify({
      base: git('rev-parse', base),
      head: git('rev-parse', 'HEAD'),
      tests,
      hashes,
      counts
    })
  )
}
