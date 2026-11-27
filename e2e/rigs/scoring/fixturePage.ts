import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BlockedError } from '../../core/result'
import type { HarnessContext, StackControl } from '../../core/spec'

/**
 * A page of the repository's own, outside the web build: a fixture that
 * draws the production field on its own (`src/test/*.fixture.tsx`), bundled
 * with the web build's settings into one HTML page with its fonts inline,
 * and served at a path of this run's own on the stack's pages stand-in. Its
 * scenarios are scripted beside it as `scenarios`; what each play reports
 * comes back as the requests the page makes of `timeline`
 * (`src/test/dictatedReport.ts`), which the stand-in lists.
 */

const ROOT = join(__dirname, '..', '..', '..')

/** Bundles `entry` (relative to the checkout) into one page. */
export type Bundle = (entry: string) => Promise<string>

/** What a page script holds raw that would end its script element. */
export function inlineScript(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script')
}

/** The web build's page, with `code` in place of its `/app.js` and its fonts inline. */
export async function pageOf(
  code: string,
  root = ROOT,
  read: (file: string) => Promise<Buffer> = async file => await readFile(file)
): Promise<string> {
  let html = (await read(join(root, 'src/app/web/index.html'))).toString('utf8')
  const fonts = new Set(
    [...html.matchAll(/\/fonts\/([\w.-]+\.ttf)/g)].map(match => match[1])
  )
  for (const font of fonts) {
    const data = (
      await read(join(root, 'src/app/assets/fonts', font))
    ).toString('base64')
    html = html.split(`/fonts/${font}`).join(`data:font/ttf;base64,${data}`)
  }
  html = html.replace(
    '</head>',
    '<style>body{overflow:hidden}#root{display:block}</style></head>'
  )
  const tag = '<script src="/app.js"></script>'
  if (!html.includes(tag)) throw new Error(`index.html has no ${tag}`)
  return html.replace(tag, () => `<script>${inlineScript(code)}</script>`)
}

/**
 * What the bundle's code reads of its environment, replaced as the web
 * build replaces it: names in the page's code, never this process's.
 */
const PAGE_ENV = ['process', 'env'].join('.')
export const BUNDLE_DEFINES: Record<string, string> = {
  __DEV__: 'true',
  global: 'globalThis',
  [PAGE_ENV]: '{}',
  [`${PAGE_ENV}.NODE_ENV`]: '"development"',
  [`${PAGE_ENV}.TS_SENTRY_DSN`]: '""'
}

/** esbuild with the web build's settings, as the fixtures were always built. */
export const bundleWithEsbuild: Bundle = async entry => {
  const { build } = await import('esbuild')
  const { webSettings } = (await import(
    join(ROOT, 'scripts/web-build-settings.mjs')
  )) as { webSettings: Record<string, unknown> }
  const built = await build({
    ...webSettings,
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    write: false,
    define: BUNDLE_DEFINES,
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
  return await pageOf(built.outputFiles[0].text)
}

export interface FixturePage {
  /** Where the page is, on the stack's pages site. */
  url: string
  path: string
  /** Each play's report so far, by its scenario's name. */
  reports: () => Promise<Map<string, any>>
}

interface Served {
  path: string
  query: string
}

/**
 * The reports a page at `path` sent, each as its `timeline` requests'
 * parts put back together: `?name=…&send=…&part=i&of=n&data=…`. A play
 * played again sends again: its last whole report counts.
 */
export function reportsOf(requests: Served[], path: string): Map<string, any> {
  const sends = new Map<string, { name: string; data: string[] }>()
  for (const request of requests) {
    if (request.path !== `${path}timeline`) continue
    const query = new URLSearchParams(request.query)
    const name = query.get('name')
    const send = query.get('send') ?? ''
    const part = Number(query.get('part'))
    const of = Number(query.get('of'))
    if (name == null || !(of > 0) || !(part >= 0 && part < of)) continue
    const key = `${name}\n${send}`
    const kept = sends.get(key) ?? {
      name,
      data: new Array<string>(of).fill('')
    }
    kept.data[part] = query.get('data') ?? ''
    // Its latest part puts it last, for a play played again.
    sends.delete(key)
    sends.set(key, kept)
  }
  const reports = new Map<string, any>()
  for (const { name, data } of sends.values()) {
    if (data.some(chunk => chunk === '')) continue
    reports.set(name, JSON.parse(data.join('')))
  }
  return reports
}

function controlOf(ctx: HarnessContext): StackControl {
  const control = ctx.stack.control
  if (control == null || ctx.stack.pagesOrigin == null)
    throw new BlockedError('this stack has no pages stand-in to serve the page')
  return control
}

/**
 * Bundles `entry` and serves it, with `scenarios` beside it, at a path of
 * this run's own. The stand-in has one script: a spec that serves a page
 * holds its stack alone (`exclusive`).
 */
export async function serveFixture(
  ctx: HarnessContext,
  entry: string,
  scenarios: unknown,
  bundle: Bundle = bundleWithEsbuild
): Promise<FixturePage> {
  const control = controlOf(ctx)
  const path = `/fixture-${randomUUID().slice(0, 8)}/`
  await control.pages.script({
    [path]: { body: await bundle(entry) },
    [`${path}scenarios`]: {
      type: 'application/json',
      body: JSON.stringify(scenarios)
    }
  })
  return {
    url: `${ctx.stack.pagesOrigin}${path}`,
    path,
    reports: async () =>
      reportsOf(
        ((await control.pages.requests(0)) as { requests: Served[] }).requests,
        path
      )
  }
}

/** Waits until the page has sent `name`'s report, and answers it. */
export async function reportOf(
  page: FixturePage,
  name: string,
  timeoutMs = 10_000,
  sleep: (ms: number) => Promise<void> = async ms => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
): Promise<any> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const report = (await page.reports()).get(name)
    if (report != null) return report
    if (Date.now() > until)
      throw new Error(`${name} did not report its timeline`)
    await sleep(250)
  }
}

/** The part of a maestro-d device a fixture's buttons need. */
export interface FixtureDevice {
  tapOn: (options: { text: string }) => Promise<unknown>
  assertVisible: (options: {
    text: string
    timeout: number
  }) => Promise<unknown>
}

/**
 * Plays each named scenario in turn on the fixture's own buttons (`Play
 * <name>`), waiting for its status to read Complete and for its report, then
 * a beat, so each play's frames stay apart. Each report gains `reportedAt`,
 * when this had it.
 */
export async function playEach(
  m: FixtureDevice,
  page: FixturePage,
  names: readonly string[],
  beatMs: number,
  sleep: (ms: number) => Promise<void> = async ms => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
): Promise<Map<string, any>> {
  const reports = new Map<string, any>()
  for (const name of names) {
    await m.tapOn({ text: `^Play ${name}$` })
    await m.assertVisible({ text: `^${name} — Complete$`, timeout: 60000 })
    const report = await reportOf(page, name, 10_000, sleep)
    reports.set(name, { ...report, reportedAt: Date.now() })
    await sleep(beatMs)
  }
  return reports
}
