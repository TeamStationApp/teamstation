import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import { FULL_LOG, FULL_LOG_BREAK } from '../../../src/app/scheduling/buildLog'
import type { E2eContext, WebSession } from '../../core/spec'

/**
 * The Auto-Scheduler's packed league on the web, for the specs that build
 * it: opening its screen signed in as the league's admin, reading the build
 * modal's log and the page's requests, and the counts a preview shows.
 * Everything that acts goes through maestro-d; the page is only read.
 */

export const SIZE = { width: 390, height: 844 }

/** The packed league's games per team in each season, built exactly. */
export const COUNTS: Record<string, number> = {
  S1: 10,
  S2: 10,
  S3: 12,
  S4: 14,
  S5: 16,
  S6: 16
}

export const COUNTS_TEXT = Object.values(COUNTS).join('/')

/** The preview's two short seasons, with the causes that really bind. */
export const SHORT_SEASON_LINES = [
  'S5: every team gets 16 of the 18 requested regular-season games.',
  'Why: not enough 46/60 field time to give every team 18 games.',
  'S6: every team gets 16 of the 18 requested regular-season games.',
  'Why: this season’s weekday/weekend game maximums leave too few available games.'
]

/** What the preview heads its unmet requests with, once it has opened. */
export const PREVIEW_OPEN = 'What couldn’t be met'

export const BUILDING = 'Building schedule'
export const LIMIT_REACHED = 'Time limit reached'
export const NO_SOLVER = 'This device can’t run the scheduler'

/** A preview calendar's day header, as on every platform: `Mon · Feb · 22`. */
export const DAY_HEADER =
  '(Sun|Mon|Tue|Wed|Thu|Fri|Sat) · (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) · \\d{1,2}'

/** A line of the build modal's log: `0:03  Model: …`. */
export const LOG_LINE = /^\d+:\d\d {2}\S/

/**
 * What heads the modal's full log, every line as it was logged, each step's
 * start (`0:00  Finding a schedule…`) and its end (`0:19  Games per team
 * settled (19.3 s)`), each better schedule and each limit. The box itself
 * shows four lines, a step's line in place as it runs and ends, so lines
 * scroll out of it. On the web the full log is a text the page never lays
 * out (read by its text content), its lines a line apart; on a phone, whose
 * drivers read the accessibility tree, it is the test id of an empty view,
 * its lines FULL_LOG_BREAK apart. Both are the modal's own, from buildLog.ts,
 * which loads no React Native.
 */
export { FULL_LOG, FULL_LOG_BREAK }

const FULL_LOG_LINES = new RegExp(`\n|${FULL_LOG_BREAK}`)

/**
 * The lines of the modal's full log among a screen's texts (the web) or ids
 * (a phone's hierarchy), or null.
 */
export function fullLogLines(texts: readonly string[]): string[] | null {
  const full = texts.find(
    text =>
      text === FULL_LOG ||
      text.startsWith(`${FULL_LOG}\n`) ||
      text.startsWith(`${FULL_LOG}${FULL_LOG_BREAK}`)
  )
  return full == null
    ? null
    : full
        .split(FULL_LOG_LINES)
        .slice(1)
        .filter(line => LOG_LINE.test(line))
}

/**
 * Keeps the page's warnings, and every line of each build's full log, where
 * a scenario can read them: the modal closes when the preview opens.
 */
export const WATCH_PAGE = `
  window.__warnings = []
  const warn = console.warn.bind(console)
  console.warn = (...args) => { window.__warnings.push(args.join(' ')); warn(...args) }
  window.__buildLogDone = []
  window.__buildLogNow = []
  window.__buildLog = () => [...window.__buildLogDone, ...window.__buildLogNow]
  new MutationObserver(() => {
    const full = document.querySelector('[data-testid="schedule-build-log-full"]')
    const lines = full == null
      ? []
      : full.textContent.split('\\n').slice(1).filter(line => line.trim() !== '')
    // A closed modal, or a new build's shorter log: the last build's is kept.
    if (lines.length < window.__buildLogNow.length) {
      window.__buildLogDone.push(...window.__buildLogNow)
      window.__buildLogNow = []
    }
    if (lines.length > 0) window.__buildLogNow = lines
  }).observe(document, { subtree: true, childList: true, characterData: true })
`

export interface Opened {
  web: WebSession
  league: string
  /** The league's name, which carries the world's nonce. */
  leagueName: string
}

/** Seeds the world, signs its admin in, and opens its Auto-Scheduler. */
export async function openScheduler(
  ctx: E2eContext,
  options: { world?: string; beforeLoad?: string } = {}
): Promise<Opened> {
  const world = await ctx.fixture(options.world ?? 'packed-league')
  const web = await ctx.browser(SIZE, {
    beforeLoad: WATCH_PAGE + (options.beforeLoad ?? '')
  })
  await web.m.openLink({ link: ctx.stack.origin })
  await ctx.signIn('admin')
  const league = world.ids.league
  await web.m.openLink({
    link: `${ctx.stack.origin}/groups/league/${encodeURIComponent(league)}/scheduler`
  })
  await ctx.checkpoint('seasons-chosen', {
    expect: Object.keys(COUNTS).map(name => ({
      text: `Auto-schedule ${name}`,
      timeout: 30_000
    })),
    readBack: async () => {
      const setup = (
        await apiGet(
          web,
          `/leagues/${encodeURIComponent(league)}/schedule-setup`
        )
      ).body as { seasonIds: string[]; fieldIds: string[] }
      expect(setup.seasonIds).lengthOf(6)
      expect(setup.fieldIds).lengthOf(5)
    }
  })
  return { web, league, leagueName: `Packed League ${world.nonce}` }
}

/** Reads an API route as the signed-in page: its status and its JSON. */
export async function apiGet(
  web: WebSession,
  path: string
): Promise<{ status: number; body: unknown }> {
  return await web.page.evaluate(async (route: string) => {
    const response = await fetch(`/api/v1${route}`, { credentials: 'include' })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text)
    }
  }, path)
}

/** The page's resource requests whose paths match. */
export async function requested(
  web: WebSession,
  pattern: RegExp
): Promise<string[]> {
  const names = await web.page.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => entry.name)
  )
  return names.filter(name => pattern.test(new URL(name).pathname))
}

export const WORKER = /^\/scheduler-worker-[A-Za-z0-9]+\.js$/
export const MODULE = /^\/scheduler-[0-9a-f]+\.wasm$/
export const RESULT = /^\/api\/v1\/schedule-previews\/([^/]+)\/result$/
export const PREPARATIONS =
  /^\/api\/v1\/leagues\/[^/]+\/schedule-previews\/preparations$/
export const DISCARD = /^\/api\/v1\/schedule-previews\/([^/]+)\/preparation$/

/** The preview a request names, from the first request matching `pattern`. */
export async function previewRequested(
  web: WebSession,
  pattern: RegExp,
  timeoutMs: number
): Promise<string> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const [sent] = await requested(web, pattern)
    const id = sent == null ? null : pattern.exec(new URL(sent).pathname)?.[1]
    if (id != null) return decodeURIComponent(id)
    if (Date.now() > until) throw new Error(`No request matched ${pattern}`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

export async function warnings(web: WebSession): Promise<string[]> {
  return await web.page.evaluate(
    () => (window as unknown as { __warnings: string[] }).__warnings
  )
}

/**
 * Every line of the full logs of the builds since the page loaded, each
 * step's start and end among them.
 */
export async function buildLog(web: WebSession): Promise<string[]> {
  return await web.page.evaluate(() =>
    (window as unknown as { __buildLog: () => string[] }).__buildLog()
  )
}

/**
 * The build modal's box as the page lays it out: its lines top to bottom,
 * its height, how far it is scrolled from its foot, and the top of its first
 * line within it; null without the modal.
 */
export async function logBox(web: WebSession): Promise<{
  /** The modal's heading: BUILDING while it builds. */
  heading: string | null
  lines: string[]
  height: number
  fromFoot: number
  firstLineTop: number | null
} | null> {
  // Runs in the page from its source text, so no `?.` or `??`: the test
  // transform turns them into helpers the page doesn't have.
  return await web.page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(
      '[data-testid="schedule-build-log"]'
    )
    if (box == null) return null
    const rows = Array.from(box.querySelectorAll<HTMLElement>('[dir="auto"]'))
    const first = rows.at(0)
    const heading = document.querySelector<HTMLElement>(
      '[data-testid="schedule-build-modal"] [role="heading"]'
    )
    return {
      heading: heading == null ? null : heading.innerText,
      lines: rows.map(row => row.innerText),
      height: box.clientHeight,
      fromFoot: box.scrollHeight - box.clientHeight - box.scrollTop,
      firstLineTop:
        first == null
          ? null
          : first.getBoundingClientRect().top - box.getBoundingClientRect().top
    }
  })
}

/**
 * Records the page's screen into an MP4 at `path` through Chrome's
 * screencast (any Chromium has it): each frame as Chrome paints it, shown
 * until the next, put together by FFmpeg at `stop`.
 */
export async function recordPage(
  web: WebSession,
  path: string
): Promise<{ stop: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'ts-screencast-'))
  const frames: Array<{ file: string; at: number }> = []
  let stopped = false
  const cdp = await web.page.createCDPSession()
  cdp.on('Page.screencastFrame', frame => {
    if (stopped) return
    const file = join(
      dir,
      `frame-${String(frames.length).padStart(5, '0')}.jpg`
    )
    writeFileSync(file, Buffer.from(frame.data, 'base64'))
    frames.push({ file, at: frame.metadata.timestamp ?? Date.now() / 1000 })
    cdp
      .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
      .catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80 })
  return {
    stop: async () => {
      stopped = true
      await cdp.send('Page.stopScreencast').catch(() => undefined)
      await cdp.detach().catch(() => undefined)
      try {
        if (frames.length === 0) throw new Error('No frames were painted')
        const list = frames.flatMap((frame, i) => [
          `file '${frame.file}'`,
          `duration ${Math.max(0.001, (frames[i + 1]?.at ?? frame.at + 0.5) - frame.at).toFixed(3)}`
        ])
        // The last frame again: FFmpeg's concat leaves the last duration out.
        list.push(`file '${frames[frames.length - 1].file}'`)
        writeFileSync(join(dir, 'frames.txt'), `${list.join('\n')}\n`)
        const made = spawnSync(
          'ffmpeg',
          [
            '-y',
            '-loglevel',
            'error',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            join(dir, 'frames.txt'),
            '-vf',
            'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-pix_fmt',
            'yuv420p',
            path
          ],
          { encoding: 'utf8' }
        )
        if (made.status !== 0) throw new Error(`FFmpeg failed: ${made.stderr}`)
      } finally {
        // Its own files, one at a time, then the empty directory.
        for (const file of [
          ...frames.map(frame => frame.file),
          join(dir, 'frames.txt')
        ])
          try {
            unlinkSync(file)
          } catch {
            // Never written: FFmpeg's list when there were no frames.
          }
        rmdirSync(dir)
      }
    }
  }
}

/**
 * A running step's line in the box: `0:04  Finding a schedule…`. A step the
 * build stopped before its end says so instead, never in its running
 * wording: STOPPED_LINE.
 */
export const RUNNING_LINE = /^(\d+):(\d\d) {2}(.+…)$/

/**
 * A step's line once the build failed before its end came, with how long it
 * ran: `0:12  Finding a schedule — stopped (12.0 s)`.
 */
export const STOPPED_LINE =
  /^(\d+:\d\d) {2}(.+) — stopped \((\d+(?:\.\d+)?) s\)$/

export async function bodyText(web: WebSession): Promise<string> {
  return await web.page.evaluate(() => document.body.innerText)
}

/**
 * Waits until the page's text shows one of `texts`, in any case, and
 * answers the first found, reading the page without acting on it.
 */
export async function firstShown(
  web: WebSession,
  texts: readonly string[],
  timeoutMs: number
): Promise<string> {
  const until = Date.now() + timeoutMs
  for (;;) {
    // A heading's text-transform reaches innerText, so case is ignored.
    const text = (await bodyText(web)).toLowerCase()
    const found = texts.find(wanted => text.includes(wanted.toLowerCase()))
    if (found != null) return found
    if (Date.now() > until)
      throw new Error(`None of ${JSON.stringify(texts)} showed`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** Every team's regular games in the preview's Fairness tab, by season. */
export async function countsShown(
  web: WebSession
): Promise<Record<string, number[]>> {
  await web.m.tapOn({ text: 'Fairness' })
  const out: Record<string, number[]> = {}
  for (const name of Object.keys(COUNTS)) {
    await web.m.tapOn({ text: name })
    await web.m.assertVisible({ text: '.*regular-season game.*' })
    const text = await bodyText(web)
    out[name] = [...text.matchAll(/(\d+) regular-season games?,/g)].map(match =>
      Number(match[1])
    )
  }
  return out
}

/** Checks every team got its season's exact count. */
export function expectExactCounts(shown: Record<string, number[]>): void {
  for (const [name, target] of Object.entries(COUNTS)) {
    expect(shown[name].length, name).greaterThan(0)
    for (const count of shown[name]) expect(count, name).equals(target)
  }
}

/** One build's timings, as `<platform>-phase-timings.log` records them. */
export interface PhaseTimings {
  command: string
  platform: string
  scenario: string
  /** From the tap on Build to the preview on screen. */
  buildToPreviewMs: number
  /**
   * The build modal's full log, each line timed from the build's start: each
   * step's start (its running wording, ending `…`) and its end.
   */
  lines: readonly string[]
  notes?: readonly string[]
  /** Said before everything else, under the command. */
  preface?: readonly string[]
  /** Said after the log. */
  appendix?: readonly string[]
}

/** A step's finished line: its time, its words and its own time. */
const FINISHED = /^(\d+:\d\d) {2}(.+?) \((\d+(?:\.\d+)?) s\)$/
/**
 * A step's line as it starts: its time and its running wording, which only
 * a running line ends in (`…`), never a stopped one.
 */
const STARTED = /^(\d+:\d\d) {2}(.+…)$/

/**
 * Each step in a full log: its words, its own time, and when it started and
 * ended on the build's clock. Steps run one at a time, so a step's end is
 * paired with the start before it; a step logged with no start has none. A
 * step the build stopped before its end (logged when the build failed, after
 * any later lines) is paired with the start in its own running wording.
 */
export function stepTimings(lines: readonly string[]): Array<{
  step: string
  seconds: string
  startedAt: string | null
  endedAt: string
  /** The build failed before this step's end: it ran `seconds`, then stopped. */
  stopped?: true
}> {
  const steps: ReturnType<typeof stepTimings> = []
  let started: { at: string; words: string } | null = null
  const starts = new Map<string, string>()
  for (const line of lines) {
    const start = STARTED.exec(line)
    if (start != null) {
      started = { at: start[1], words: start[2] }
      starts.set(start[2], start[1])
      continue
    }
    const stop = STOPPED_LINE.exec(line)
    if (stop != null) {
      const words = `${stop[2]}…`
      steps.push({
        step: stop[2],
        seconds: stop[3],
        startedAt: starts.get(words) ?? null,
        endedAt: stop[1],
        stopped: true
      })
      if (started?.words === words) started = null
      continue
    }
    // A better schedule's line ends in its gap and a limit's in `possible`,
    // never in seconds: only a step's end is finished.
    const end = FINISHED.exec(line)
    if (end == null) continue
    steps.push({
      step: end[2],
      seconds: end[3],
      startedAt: started?.at ?? null,
      endedAt: end[1]
    })
    started = null
  }
  return steps
}

/**
 * The log's section for one build: the command, Build to preview, and each
 * step the modal logged, with its own time, its start and its end.
 */
export function phaseTimingsText(timings: PhaseTimings): string {
  const phases = stepTimings(timings.lines).map(
    ({ step, seconds, startedAt, endedAt, stopped }) =>
      `  ${step}: ${stopped === true ? 'stopped after ' : ''}${seconds} s (${startedAt == null ? '' : `started at ${startedAt}, `}logged at ${endedAt})`
  )
  return [
    `$ ${timings.command}`,
    `# ${timings.platform}, ${timings.scenario}, ${new Date().toISOString()}`,
    ...(timings.preface ?? []),
    `Build to preview: ${(timings.buildToPreviewMs / 1000).toFixed(1)} s`,
    'Phases (each step’s own time, as the modal logged it, with its start and end on the build’s clock, which stops while waiting at a time limit):',
    ...phases,
    ...(timings.notes ?? []),
    'The modal’s full log (each step’s start, then its end):',
    ...timings.lines.map(line => `  ${line}`),
    ...(timings.appendix ?? []),
    ''
  ].join('\n')
}

/** A phase's log line, as the modal shows it, with its own time. */
const PHASE_LINE = /^(\d+:\d\d)\s+(\S.*\(\d+(?:\.\d+)? s\))$/

/** The fewest single-character edits that turn `a` into `b`. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++)
      current.push(
        Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        )
      )
    previous = current
  }
  return previous[b.length]
}

/**
 * The phase lines a screen recording's frames show while the modal titled
 * `title` is up, in the modal's spacing ("0:33  Options polished (0.9 s)"),
 * each with the first frame it is in and how many frames show it; and the
 * first and last frames with the modal. A line within two characters of one
 * read in an earlier frame, and never in the same frame as it, is the same
 * line on screen misread (cut by the log's scroll, or caught mid-scroll or
 * closing), and is left out: a line comes in whole at the log's foot, and
 * two lines that differ really are on screen together.
 */
export function recordedPhaseLines(
  frames: ReadonlyArray<{ atSec: number; lines: readonly string[] }>,
  title: string
): {
  firstModalSec: number | null
  lastModalSec: number | null
  lines: Array<{ line: string; firstSec: number; frames: number }>
} {
  const modal = frames.filter(frame => frame.lines.includes(title))
  const lines: Array<{
    line: string
    firstSec: number
    frames: number
    seenIn: Set<number>
  }> = []
  for (const [index, frame] of modal.entries()) {
    const inFrame = new Set<string>()
    for (const text of frame.lines) {
      const match = PHASE_LINE.exec(text.trim())
      if (match != null) inFrame.add(`${match[1]}  ${match[2]}`)
    }
    for (const line of inFrame) {
      const seen = lines.find(other => other.line === line)
      if (seen == null)
        lines.push({
          line,
          firstSec: frame.atSec,
          frames: 1,
          seenIn: new Set([index])
        })
      else {
        seen.frames++
        seen.seenIn.add(index)
      }
    }
  }
  return {
    firstModalSec: modal.at(0)?.atSec ?? null,
    lastModalSec: modal.at(-1)?.atSec ?? null,
    lines: lines
      .filter(
        read =>
          !lines.some(
            other =>
              other.firstSec < read.firstSec &&
              editDistance(other.line, read.line) <= 2 &&
              ![...read.seenIn].some(index => other.seenIn.has(index))
          )
      )
      .map(({ line, firstSec, frames: count }) => ({
        line,
        firstSec,
        frames: count
      }))
  }
}

interface Node {
  id?: string
  text?: string
  children?: Node[]
}

/** Every text in a maestro-d hierarchy, depth first. */
export function hierarchyTexts(node: Node): string[] {
  return [
    ...(node.text == null || node.text === '' ? [] : [node.text]),
    ...(node.children ?? []).flatMap(hierarchyTexts)
  ]
}

/** Every id (a test id) in a maestro-d hierarchy, depth first. */
export function hierarchyIds(node: Node): string[] {
  return [
    ...(node.id == null || node.id === '' ? [] : [node.id]),
    ...(node.children ?? []).flatMap(hierarchyIds)
  ]
}
