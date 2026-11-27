import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

import {
  decodedMappings,
  type EncodedSourceMap,
  TraceMap
} from '@jridgewell/trace-mapping'
import istanbul, { type FileCoverage } from 'istanbul-lib-coverage'

import type { WebSession } from '../core/spec'
import type { Page } from '../core/web'

/** One script's coverage as the page's browser reports it. */
type JSCoverageEntry = Awaited<
  ReturnType<Page['coverage']['stopJSCoverage']>
>[number]

const paths = [
  'src/app/web/iosAppBanner.ts',
  'src/app/screens/NodeSettingsCard.tsx',
  'src/common/nodeSettings.ts'
]

/** Credit an original line only when a mapped position ran in Chromium. */
function browserLines(
  entry: JSCoverageEntry,
  map: TraceMap,
  sourcePaths: Array<string | undefined>
): Array<FileCoverage | undefined> {
  const files = sourcePaths.map(path =>
    path == null ? undefined : istanbul.createFileCoverage(path)
  )
  const originals = sourcePaths.map((path, i) => {
    if (path == null) return undefined
    const content = map.sourcesContent?.[i]
    if (content == null)
      throw new Error('Missing browser source content: ' + path)
    return content.split('\n')
  })
  const starts = [0]
  for (const newline of entry.text.matchAll(/\n/g))
    starts.push(newline.index + 1)
  let range = 0
  for (const [generatedLine, segments] of decodedMappings(map).entries()) {
    for (const segment of segments) {
      if (segment.length === 1) continue
      const [column, source, originalLine] = segment
      const file = files[source]
      if (file == null) continue
      const offset = starts[generatedLine] + column
      // Puppeteer supplies ordered, disjoint, half-open ranges with V8 hits.
      while (range < entry.ranges.length && entry.ranges[range].end <= offset)
        range++
      const line = originalLine + 1
      file.statementMap[line] ??= {
        start: { line, column: 0 },
        end: { line, column: originals[source]![originalLine].length }
      }
      const hit =
        range < entry.ranges.length && entry.ranges[range].start <= offset
      file.s[line] = Math.max(file.s[line] ?? 0, Number(hit))
    }
  }
  return files
}

/**
 * Source maps for an attached HTTPS stack come from the very build under
 * test. It measures only when its caller names where to write (`output`)
 * and the release build it measured (`webDir`); otherwise it only watches.
 */
export function bannerBrowserCoverage(
  origin: string,
  options: { output?: string; webDir?: string } = {}
): {
  watch: (session: WebSession, request?: 'skipped') => Promise<WebSession>
  finish: () => Promise<void>
} {
  const { output, webDir } = options
  const require = createRequire(resolve('package.json'))
  const { coverageSource } = require('./scripts/ios-app-banner-source.cjs') as {
    coverageSource: () => string
  }
  const source = output == null ? undefined : coverageSource()
  const sessions: Array<{ session: WebSession; request?: 'skipped' }> = []
  return {
    async watch(session: WebSession, request?: 'skipped'): Promise<WebSession> {
      if (output != null) {
        if (webDir == null || webDir === '')
          throw new Error(
            'Name webDir, the tested release build, beside output'
          )
        await session.page.coverage.startJSCoverage({
          resetOnNavigation: false
        })
        sessions.push({ session, request })
      }
      return session
    },
    async finish(): Promise<void> {
      if (output == null || webDir == null) return
      const release = JSON.parse(
        await readFile(resolve(webDir, 'ios-app-banner-coverage.json'), 'utf8')
      ) as { source: string; assets: Record<string, string> }
      if (release.source !== source || coverageSource() !== source)
        throw new Error(
          'Browser build or tests belong to another source revision'
        )
      const readAsset = async (file: string): Promise<string> => {
        const bytes = await readFile(file)
        if (
          createHash('sha256').update(bytes).digest('hex') !==
          release.assets[basename(file)]
        )
          throw new Error(
            'Browser asset differs from the measured build: ' + basename(file)
          )
        return bytes.toString('utf8')
      }
      const coverage = istanbul.createCoverageMap({})
      const verified = new Set<string>()
      for (const {
        session: { page },
        request
      } of sessions) {
        let checkedRequest = false
        for (const entry of await page.coverage.stopJSCoverage()) {
          const url = new URL(entry.url)
          if (
            url.origin !== origin ||
            !/^\/app-(?:ios-app-banner-)?[A-Z0-9]+\.js$/.test(url.pathname)
          )
            continue
          const file = resolve(webDir, basename(url.pathname))
          if ((await readAsset(file)) !== entry.text)
            throw new Error(
              'Browser code differs from the release used for coverage: ' +
                url.pathname
            )
          const map = new TraceMap(
            JSON.parse(await readAsset(file + '.map')) as EncodedSourceMap
          )
          const sourcePaths = map.sources.map(name =>
            paths.find(path => name?.endsWith('/' + path) === true)
          )
          const files = browserLines(entry, map, sourcePaths)
          for (const [i, report] of files.entries()) {
            if (report == null) continue
            const content = await readFile(report.path, 'utf8')
            if (map.sourcesContent?.[i] !== content)
              throw new Error(
                'Source map differs from checkout: ' + report.path
              )
            verified.add(report.path)
            if (request === 'skipped' && report.path === paths[0]) {
              const assignment =
                content
                  .split('\n')
                  .findIndex(
                    line =>
                      line.trim() ===
                      'page.teamStationAppBannerRequested = true'
                  ) + 1
              if (report.s[assignment] !== 0)
                throw new Error(
                  'Excluded browser must measure zero hits on the banner request assignment'
                )
              checkedRequest = true
            }
            coverage.addFileCoverage(report)
          }
        }
        if (request === 'skipped' && !checkedRequest)
          throw new Error(
            'Excluded browser did not measure the release banner script'
          )
      }
      for (const path of paths)
        if (!verified.has(path))
          throw new Error('Missing browser source: ' + path)
      await mkdir(dirname(output), { recursive: true })
      await writeFile(
        output,
        JSON.stringify({
          source,
          report: coverage.toJSON()
        })
      )
    }
  }
}
