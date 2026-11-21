import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'

import { expect } from 'chai'
import { JSDOM } from 'jsdom'
import { describe, it } from 'mocha'

import * as modalLog from '../../../src/app/scheduling/buildLog'
import type { WebSession } from '../../core/spec'
import {
  COUNTS,
  DAY_HEADER,
  editDistance,
  FULL_LOG,
  FULL_LOG_BREAK,
  fullLogLines,
  hierarchyIds,
  hierarchyTexts,
  LOG_LINE,
  logBox,
  phaseTimingsText,
  recordedPhaseLines,
  recordPage,
  RUNNING_LINE,
  stepTimings,
  STOPPED_LINE,
  WATCH_PAGE
} from './autoScheduler'

/**
 * A page whose screencast paints `frames` (not real JPEGs) when it starts,
 * and one more after it stops.
 */
function screencastPage(frames: number): {
  web: WebSession
  late: () => void
} {
  let paint: ((frame: unknown) => void) | undefined
  const cdp = {
    on: (_event: string, listener: (frame: unknown) => void) => {
      paint = listener
    },
    send: async (method: string) => {
      if (method === 'Page.startScreencast')
        for (let i = 0; i < frames; i++)
          paint?.({
            data: Buffer.from(`frame ${i}`).toString('base64'),
            metadata: { timestamp: i / 10 },
            sessionId: i
          })
    },
    detach: async () => undefined
  }
  return {
    web: {
      page: { createCDPSession: async () => cdp }
    } as unknown as WebSession,
    late: () =>
      paint?.({
        data: Buffer.from('late').toString('base64'),
        metadata: {},
        sessionId: 99
      })
  }
}

const screencastDirs = (): string[] =>
  readdirSync(tmpdir()).filter(name => name.startsWith('ts-screencast-'))

describe('the Auto-Scheduler rig', function () {
  for (const frames of [0, 2])
    it(`removes its recording’s frames, one at a time, when it can’t make the video (${frames} frames)`, async function () {
      const before = screencastDirs()
      const { web, late } = screencastPage(frames)
      const recording = await recordPage(web, '/nonexistent/web-build.mp4')
      expect(screencastDirs()).lengthOf(before.length + 1)
      let failed: unknown
      await recording.stop().catch((error: unknown) => {
        failed = error
      })
      // A frame painted after the stop is not written.
      late()
      expect(String(failed)).matches(
        frames === 0 ? /No frames were painted/ : /FFmpeg|ENOENT|spawn/
      )
      expect(screencastDirs()).deep.equals(before)
    })

  it('reads the log box in the page from its source alone, with no helper of the test transform', async function () {
    const rect = (top: number): { top: number } => ({ top })
    const row = {
      innerText: '0:02  Finding a schedule…',
      getBoundingClientRect: () => rect(90)
    }
    const box = {
      clientHeight: 80,
      scrollHeight: 160,
      scrollTop: 80,
      querySelectorAll: () => [row],
      getBoundingClientRect: () => rect(20)
    }
    // The page has only its document: a function the transform gave a helper
    // fails here as it does in the browser.
    const page = (
      heading: unknown
    ): { evaluate: (fn: () => unknown) => Promise<unknown> } => ({
      evaluate: async (fn: () => unknown) =>
        runInNewContext(`(${fn.toString()})()`, {
          document: {
            querySelector: (selector: string) =>
              selector.includes('heading') ? heading : box
          }
        })
    })
    const read = async (
      heading: unknown
    ): Promise<Awaited<ReturnType<typeof logBox>>> =>
      await logBox({ page: page(heading) } as unknown as WebSession)
    expect(await read({ innerText: 'Building schedule' })).deep.equals({
      heading: 'Building schedule',
      lines: ['0:02  Finding a schedule…'],
      height: 80,
      fromFoot: 0,
      firstLineTop: 70
    })
    expect((await read(null))?.heading).equals(null)
  })

  it('knows the packed league’s exact counts', function () {
    expect(Object.values(COUNTS).join('/')).equals('10/10/12/14/16/16')
  })

  it('matches a day header as every platform shows it, and not Hermes’s old one', function () {
    const header = new RegExp(`^${DAY_HEADER}$`)
    expect(header.test('Mon · Feb · 22')).equals(true)
    expect(header.test('Sat · Dec · 5')).equals(true)
    expect(header.test('undefined · undefined · 22')).equals(false)
  })

  it('tells the modal’s log lines from the rest of the screen', function () {
    expect(
      LOG_LINE.test('0:03  Model: 23,776 possible games, 10,685 rules (1.2 s)')
    ).equals(true)
    expect(LOG_LINE.test('12:05  Games placed (4.0 s)')).equals(true)
    expect(LOG_LINE.test('Building schedule')).equals(false)
    expect(LOG_LINE.test('3:15 PM')).equals(false)
  })

  it('reads every text of a hierarchy, depth first', function () {
    expect(
      hierarchyTexts({
        children: [
          { text: 'Building schedule' },
          { text: '', children: [{ text: '0:01  Prepared (0.4 s)' }] },
          { children: [] }
        ]
      })
    ).deep.equals(['Building schedule', '0:01  Prepared (0.4 s)'])
  })

  it('writes a build’s timings under its command, with each phase’s own time', function () {
    const text = phaseTimingsText({
      command: 'npm run -s e2e -- run x#y',
      platform: 'web-chromium',
      scenario: 'x#y',
      buildToPreviewMs: 14_250,
      lines: [
        '0:00  Prepared (0.4 s)',
        '0:05  Found a schedule with 330 games — at most 338 possible (2.4%)',
        '0:09  Games per team settled (8.1 s)'
      ],
      notes: ['a note']
    }).split('\n')
    expect(text[0]).equals('$ npm run -s e2e -- run x#y')
    expect(text).includes('Build to preview: 14.3 s')
    expect(text).includes('  Prepared: 0.4 s (logged at 0:00)')
    expect(text).includes('  Games per team settled: 8.1 s (logged at 0:09)')
    expect(text.filter(line => line.includes('Found a schedule'))).lengthOf(1)
    expect(text).includes('a note')
  })

  it('pairs each step’s end with its start, the better schedules between them', function () {
    const lines = [
      '0:00  Preparing…',
      '0:00  Prepared (0.4 s)',
      '0:00  Finding a schedule…',
      '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)',
      '0:12  Time limit reached: best 330 games; at most 338 possible',
      '0:19  Games per team settled (19.3 s)',
      '0:19  Shortfall explained: S5 (5.0 s)'
    ]
    expect(stepTimings(lines)).deep.equals([
      { step: 'Prepared', seconds: '0.4', startedAt: '0:00', endedAt: '0:00' },
      {
        step: 'Games per team settled',
        seconds: '19.3',
        startedAt: '0:00',
        endedAt: '0:19'
      },
      {
        step: 'Shortfall explained: S5',
        seconds: '5.0',
        startedAt: null,
        endedAt: '0:19'
      }
    ])
    const text = phaseTimingsText({
      command: 'c',
      platform: 'p',
      scenario: 's',
      buildToPreviewMs: 20_000,
      lines
    }).split('\n')
    expect(text).includes(
      '  Games per team settled: 19.3 s (started at 0:00, logged at 0:19)'
    )
    expect(text).includes('  Shortfall explained: S5: 5.0 s (logged at 0:19)')
    expect(text).includes('  0:00  Finding a schedule…')
  })

  it('keeps a finished build’s log to its upload’s end, shown just before the modal closes', async function () {
    const dom = new JSDOM('<!doctype html><body></body>', {
      runScripts: 'outside-only'
    })
    const { document } = dom.window
    dom.window.eval(WATCH_PAGE)
    const changed = async (): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const full = document.createElement('div')
    full.setAttribute('data-testid', 'schedule-build-log-full')
    full.textContent = [FULL_LOG, '0:00  Preparing…'].join('\n')
    document.body.appendChild(full)
    await changed()
    full.textContent = [
      FULL_LOG,
      '0:00  Preparing…',
      '0:00  Prepared (0.4 s)',
      '0:00  Finding a schedule…',
      '0:10  Games placed (10.2 s)',
      '0:11  Saving…'
    ].join('\n')
    await changed()
    // The upload's end, as the modal shows it for one render, then closes.
    full.textContent = `${full.textContent}\n0:12  Saved (0.8 s)`
    await changed()
    full.remove()
    await changed()
    const lines = (
      dom.window as unknown as { __buildLog: () => string[] }
    ).__buildLog()
    expect(lines.at(-1)).equals('0:12  Saved (0.8 s)')
    expect(stepTimings(lines).at(-1)).deep.equals({
      step: 'Saved',
      seconds: '0.8',
      startedAt: '0:11',
      endedAt: '0:12'
    })
    expect(
      phaseTimingsText({
        command: 'c',
        platform: 'p',
        scenario: 's',
        buildToPreviewMs: 13_000,
        lines
      }).split('\n')
    ).includes('  Saved: 0.8 s (started at 0:11, logged at 0:12)')
    dom.window.close()
  })

  it('tells a step the build stopped from a running one, and times it', function () {
    const stopped = '0:12  Finding a schedule — stopped (12.0 s)'
    expect(RUNNING_LINE.test(stopped)).equals(false)
    expect(RUNNING_LINE.test('0:12  Finding a schedule…')).equals(true)
    expect(STOPPED_LINE.exec(stopped)?.slice(1)).deep.equals([
      '0:12',
      'Finding a schedule',
      '12.0'
    ])
    expect(STOPPED_LINE.test('0:19  Games per team settled (19.3 s)')).equals(
      false
    )
    // A failed build's full log: the model's line stopped by the next
    // step's start, both said stopped when the build failed.
    const lines = [
      '0:00  Prepared (0.4 s)',
      '0:01  Building the model…',
      '0:02  Finding a schedule…',
      '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)',
      '0:02  Building the model — stopped (1.5 s)',
      '0:14  Finding a schedule — stopped (12.0 s)'
    ]
    expect(stepTimings(lines)).deep.equals([
      { step: 'Prepared', seconds: '0.4', startedAt: null, endedAt: '0:00' },
      {
        step: 'Building the model',
        seconds: '1.5',
        startedAt: '0:01',
        endedAt: '0:02',
        stopped: true
      },
      {
        step: 'Finding a schedule',
        seconds: '12.0',
        startedAt: '0:02',
        endedAt: '0:14',
        stopped: true
      }
    ])
    expect(
      phaseTimingsText({
        command: 'c',
        platform: 'p',
        scenario: 's',
        buildToPreviewMs: 0,
        lines
      }).split('\n')
    ).includes(
      '  Finding a schedule: stopped after 12.0 s (started at 0:02, logged at 0:14)'
    )
  })

  it('reads the full log by the modal’s own heading and separator', function () {
    expect(FULL_LOG).equals(modalLog.FULL_LOG)
    expect(FULL_LOG_BREAK).equals(modalLog.FULL_LOG_BREAK)
    // A log as the modal writes it, on the web and on a phone.
    const log = [
      { type: 'event', event: { kind: 'phase-start', phase: 'model' }, at: 0 },
      {
        type: 'event',
        event: { kind: 'phase', phase: 'model', ms: 1200 },
        at: 1200
      }
    ] as const satisfies readonly modalLog.BuildLogAction[]
    const lines = log
      .reduce(modalLog.logReducer, modalLog.startLog(0))
      .transcript.map(modalLog.lineText)
    for (const separator of ['\n', modalLog.FULL_LOG_BREAK])
      expect(
        fullLogLines([[modalLog.FULL_LOG, ...lines].join(separator)])
      ).deep.equals(['0:00  Building the model…', '0:01  Model (1.2 s)'])
  })

  it('finds the modal’s full log among a screen’s texts', function () {
    expect(
      fullLogLines(['Building schedule', '0:02  Finding a schedule…'])
    ).equals(null)
    expect(fullLogLines([FULL_LOG])).deep.equals([])
    expect(
      fullLogLines([
        'Building schedule',
        `${FULL_LOG}\n0:00  Preparing…\n0:00  Prepared (0.4 s)\n`,
        '0:00  Prepared (0.4 s)'
      ])
    ).deep.equals(['0:00  Preparing…', '0:00  Prepared (0.4 s)'])
    // A phone's: the test id of an empty view, its lines a line separator
    // apart.
    expect(
      fullLogLines(
        hierarchyIds({
          children: [
            { id: 'schedule-build-log', text: '0:00  Preparing…' },
            {
              id: [FULL_LOG, '0:00  Preparing…', '0:00  Prepared (0.4 s)'].join(
                FULL_LOG_BREAK
              )
            },
            { children: [{ id: '' }] }
          ]
        })
      )
    ).deep.equals(['0:00  Preparing…', '0:00  Prepared (0.4 s)'])
  })

  it('reads the phase lines a recording shows while the modal is up', function () {
    const read = recordedPhaseLines(
      [
        {
          atSec: 32.75,
          lines: ['Building schedule', '0:32 Shortfall explained: S6 (1.2 s)']
        },
        {
          atSec: 33,
          lines: [
            'Building schedule',
            '0:19 Found a schedule with 333 games - at most',
            '0:32 Shortfall explained: S6 (1.2 s)',
            '0:33 Options polished (0.9 s)',
            ' 0:33 Options chosen (0.0 s) ',
            'Cancel'
          ]
        },
        {
          atSec: 33.5,
          lines: ['WHAT COULDN’T BE MET', '0:40 Not a log (1.0 s)']
        }
      ],
      'Building schedule'
    )
    expect(read.lastModalSec).equals(33)
    expect(read.lines).deep.equals([
      {
        line: '0:32  Shortfall explained: S6 (1.2 s)',
        firstSec: 32.75,
        frames: 2
      },
      { line: '0:33  Options polished (0.9 s)', firstSec: 33, frames: 1 },
      { line: '0:33  Options chosen (0.0 s)', firstSec: 33, frames: 1 }
    ])
    expect(read.firstModalSec).equals(32.75)
    expect(recordedPhaseLines([], 'Building schedule')).deep.equals({
      firstModalSec: null,
      lastModalSec: null,
      lines: []
    })
  })

  it('leaves out a later misreading of a line, and keeps lines on screen together', function () {
    const frame = (
      atSec: number,
      ...lines: string[]
    ): { atSec: number; lines: string[] } => ({
      atSec,
      lines: ['Building schedule', ...lines]
    })
    const s5 = '0:32 Shortfall explained: S5 (1.0 s)'
    const s6 = '0:32 Shortfall explained: S6 (1.0 s)'
    const read = recordedPhaseLines(
      [
        frame(27.5, '0:00 Prepared (0.3 s)'),
        // Cut at the top of the log, more often than not.
        frame(27.75, '0:00 Prepared (0.5 s)'),
        frame(28, '0:00 Prepared (0.5 s)'),
        frame(32.75, '0:00 Prepared (0.5 s)', s5),
        frame(33, '0:32 Shorttall explained: S5 (1.0 s)', s6),
        frame(34, s5, s6, '0:34 Options chosen (0.0 s)'),
        frame(35.25, '0:32 Shortfall explained: 85 (1.0 s)', s6)
      ],
      'Building schedule'
    )
    expect(read.lines.map(({ line, frames }) => [line, frames])).deep.equals([
      ['0:00  Prepared (0.3 s)', 1],
      ['0:32  Shortfall explained: S5 (1.0 s)', 2],
      // One character from S5's, but on screen with it.
      ['0:32  Shortfall explained: S6 (1.0 s)', 3],
      ['0:34  Options chosen (0.0 s)', 1]
    ])
  })

  it('counts the edits between two lines', function () {
    expect(editDistance('S5', 'S5')).equals(0)
    expect(editDistance('S5', '85')).equals(1)
    expect(editDistance('Shortfall', 'Shorttall')).equals(1)
    expect(editDistance('', 'abc')).equals(3)
    expect(editDistance('Options polished', 'Options chosen')).greaterThan(2)
  })

  it('puts a preface under the command and an appendix after the log', function () {
    const text = phaseTimingsText({
      command: 'run',
      platform: 'ios-app',
      scenario: 's',
      buildToPreviewMs: 1000,
      lines: ['0:00  Prepared (0.3 s)'],
      preface: ['# sampled'],
      appendix: ['recorded']
    })
    const lines = text.split('\n')
    expect(lines[2]).equals('# sampled')
    expect(lines.at(-2)).equals('recorded')
  })
})
