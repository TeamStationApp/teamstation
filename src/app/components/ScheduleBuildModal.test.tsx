import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type {
  BuildEvent,
  BuildSession,
  PreviewRequest,
  SchedulePreview
} from '../../common/schedulePreviews'
import { EngineFailureError } from '../../common/scheduler/wire'
import {
  type BuildLog,
  FULL_LOG,
  FULL_LOG_BREAK,
  logReducer,
  startLog
} from '../scheduling/buildLog'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  AWAITING_FIRST,
  ScheduleBuildModal,
  type ScheduleBuildState,
  useScheduleBuild,
  USING_FIRST
} from './ScheduleBuildModal'

let root: Root | undefined
let host: HTMLElement | undefined

/** A log of three lines, the build started at T0. */
const T0 = 1_000_000
const LOG: BuildLog = [
  { kind: 'phase' as const, phase: 'preparing' as const, ms: 400, at: 400 },
  {
    kind: 'phase' as const,
    phase: 'model' as const,
    ms: 1234,
    detail: { columns: 23776, rows: 10685 },
    at: 3000
  },
  {
    kind: 'progress' as const,
    incumbentGames: 330,
    boundGames: 338,
    gap: 0.024,
    at: 9000
  }
].reduce(
  (log, { at, ...event }) =>
    logReducer(log, { type: 'event', event, at: T0 + at }),
  startLog(T0)
)

async function render(
  state: ScheduleBuildState,
  pressed: string[],
  log: BuildLog = LOG,
  driverLog?: boolean
): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <ScheduleBuildModal
          state={state}
          log={log}
          onCancel={() => pressed.push('cancel')}
          onContinue={() => pressed.push('continue')}
          onUse={() => pressed.push('use')}
          onClose={() => pressed.push('close')}
          driverLog={driverLog}
        />
      </ThemeProvider>
    )
  })
}

function buttons(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="button"]')
  ).map(node => node.textContent ?? '')
}

function press(label: string): void {
  const target = Array.from(
    document.querySelectorAll<HTMLElement>('[role="button"]')
  ).find(node => node.textContent === label)
  if (target == null) throw new Error(`no ${label} button`)
  target.click()
}

const shown = (): string => document.body.textContent ?? ''

describe('ScheduleBuildModal', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    if (host?.parentNode != null) host.parentNode.removeChild(host)
    host = undefined
  })

  it('shows the build’s timed log, with Cancel', async function () {
    const pressed: string[] = []
    await render({ kind: 'building' }, pressed)
    expect(shown()).includes('Building schedule')
    expect(shown()).includes(
      '0:03  Model: 23,776 possible games, 10,685 rules (1.2 s)'
    )
    expect(shown()).includes(
      '0:09  Found a schedule with 330 games — at most 338 possible (2.4%)'
    )
    expect(buttons()).deep.equals(['Cancel'])
    await act(async () => {
      press('Cancel')
    })
    expect(pressed).deep.equals(['cancel'])
  })

  it('at the time limit offers to go on, use the best found, or cancel', async function () {
    const pressed: string[] = []
    await render(
      { kind: 'limit', solvedMs: 120000, bestGames: 330, boundGames: 338 },
      pressed
    )
    expect(shown()).includes('Time limit reached')
    expect(shown()).includes(
      'After 2:00 the solver hasn’t proven this is the best schedule. Best found: 330 games; at most 338 possible.'
    )
    expect(buttons()).deep.equals([
      'Continue processing',
      'Use this schedule',
      'Cancel'
    ])
    await act(async () => {
      press('Continue processing')
      press('Use this schedule')
      press('Cancel')
    })
    expect(pressed).deep.equals(['continue', 'use', 'cancel'])
  })

  it('words the limit from the solve time, as at a second limit', async function () {
    await render(
      { kind: 'limit', solvedMs: 240500, bestGames: 1336, boundGames: 1338 },
      []
    )
    expect(shown()).includes(
      'After 4:00 the solver hasn’t proven this is the best schedule. Best found: 1,336 games; at most 1,338 possible.'
    )
  })

  it('says when the solver has found no schedule yet at the limit', async function () {
    await render(
      { kind: 'limit', solvedMs: 3100, bestGames: null, boundGames: 338 },
      []
    )
    expect(shown()).includes(
      'After 0:03 the solver hasn’t found a schedule yet; at most 338 games possible.'
    )
  })

  it('says while building that it will use the first schedule found', async function () {
    await render({ kind: 'building', awaitingFirst: true }, [])
    expect(shown()).includes('Building schedule')
    expect(shown()).includes(AWAITING_FIRST)
    // The wait is bounded: one more time limit, then the build stops.
    expect(AWAITING_FIRST).includes('within another time limit')
    expect(buttons()).deep.equals(['Cancel'])
  })

  it('says when this device can’t run the scheduler, with only Close', async function () {
    const pressed: string[] = []
    await render(
      { kind: 'noSolver', reason: 'This browser has no WebAssembly.' },
      pressed
    )
    expect(shown()).includes('This device can’t run the scheduler')
    expect(shown()).includes('This browser has no WebAssembly.')
    expect(buttons()).deep.equals(['Close'])
    await act(async () => {
      press('Close')
    })
    expect(pressed).deep.equals(['close'])
  })

  it('says when the schedule couldn’t be built, with the message', async function () {
    await render({ kind: 'failed', message: 'The model is too large.' }, [])
    expect(shown()).includes('The schedule couldn’t be built')
    expect(shown()).includes('The model is too large.')
    expect(buttons()).deep.equals(['Close'])
  })

  /** The log's box, and the lines it shows, top to bottom. */
  const box = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>(
      '[data-testid="schedule-build-log"]'
    )
    if (found == null) throw new Error('no log box')
    return found
  }
  const boxLines = (): string[] =>
    Array.from(box().querySelectorAll('[dir="auto"]')).map(
      node => node.textContent ?? ''
    )
  const fullLog = (): string[] =>
    (
      document.querySelector('[data-testid="schedule-build-log-full"]')
        ?.textContent ?? ''
    ).split('\n')
  const px = (node: Element, property: string): number =>
    parseFloat(getComputedStyle(node).getPropertyValue(property))

  it('keeps its log four lines high from the start, the first line on the bottom row', async function () {
    await render({ kind: 'building' }, [], startLog(T0))
    const empty = box()
    const height = px(empty, 'height')
    expect(height).greaterThan(0)
    // A box's height of room above the lines: with none yet, the box shows
    // only that room, so the first line comes in on the bottom row.
    const room = empty.firstElementChild?.firstElementChild
    if (room == null) throw new Error('no room above the lines')
    expect(px(room, 'height')).equals(height)
    expect(boxLines()).deep.equals([])
    await act(async () => {
      root?.unmount()
    })
    await render({ kind: 'building' }, [])
    // The same height with lines in it: it never grows.
    expect(px(box(), 'height')).equals(height)
    const rows = box().querySelectorAll('[dir="auto"]')
    expect(rows).lengthOf(3)
    for (const row of Array.from(rows)) {
      // Four rows of text fill the box, and a long line wraps onto more.
      expect(px(row, 'line-height') * 4).equals(height)
      expect(getComputedStyle(row).whiteSpace).not.equals('nowrap')
      expect(
        getComputedStyle(row).getPropertyValue('-webkit-line-clamp')
      ).equals('')
    }
    expect(boxLines()).deep.equals([
      '0:00  Prepared (0.4 s)',
      '0:03  Model: 23,776 possible games, 10,685 rules (1.2 s)',
      '0:09  Found a schedule with 330 games — at most 338 possible (2.4%)'
    ])
    // The same box at a time limit and after a failure.
    await act(async () => {
      root?.unmount()
    })
    await render({ kind: 'failed', message: 'The model is too large.' }, [])
    expect(px(box(), 'height')).equals(height)
  })

  it('carries every line as logged in a text the page never lays out, for tests and timing logs', async function () {
    const log = [
      { kind: 'phase-start' as const, phase: 'targets' as const, at: 400 },
      {
        kind: 'progress' as const,
        incumbentGames: 330,
        boundGames: 341,
        gap: 0.024,
        at: 9000
      },
      {
        kind: 'phase' as const,
        phase: 'targets' as const,
        ms: 18_900,
        at: 19_300
      }
    ].reduce(
      (built, { at, ...event }) =>
        logReducer(built, { type: 'event', event, at: T0 + at }),
      startLog(T0)
    )
    await render({ kind: 'building' }, [], log)
    expect(fullLog()).deep.equals([
      FULL_LOG,
      '0:00  Finding a schedule…',
      '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)',
      '0:19  Games per team settled (18.9 s)'
    ])
    expect(boxLines()).deep.equals([
      '0:19  Games per team settled (18.9 s)',
      '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)'
    ])
    const full = document.querySelector(
      '[data-testid="schedule-build-log-full"]'
    )
    if (full == null) throw new Error('no full log')
    // Never laid out, so find in page, a selection and a copy pass over it,
    // and never read out by a screen reader.
    const style = getComputedStyle(full)
    expect(style.display).equals('none')
    expect(style.userSelect).equals('none')
    expect(style.pointerEvents).equals('none')
    expect(full.closest('[aria-hidden="true"]')).equals(full)
  })

  for (const platform of ['ios', 'android'] as const)
    it(`carries the whole log on ${platform}, in a develop build alone, as an empty view’s test id, which no screen reader reads`, async function () {
      const os = Object.getOwnPropertyDescriptor(Platform, 'OS')
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: platform
      })
      try {
        const log = [
          { kind: 'phase-start' as const, phase: 'targets' as const, at: 400 },
          {
            kind: 'phase' as const,
            phase: 'targets' as const,
            ms: 18_900,
            at: 19_300
          }
        ].reduce(
          (built, { at, ...event }) =>
            logReducer(built, { type: 'event', event, at: T0 + at }),
          startLog(T0)
        )
        // A stable build, as these tests' builds are: no full log at all.
        await render({ kind: 'building' }, [], log)
        expect(
          Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))
            .map(node => node.dataset.testid ?? '')
            .filter(id => id.includes(FULL_LOG))
        ).deep.equals([])
        await act(async () => {
          root?.unmount()
        })
        await render({ kind: 'building' }, [], log, true)
        expect(
          document.querySelector('[data-testid="schedule-build-log-full"]')
        ).equals(null)
        const id = [
          FULL_LOG,
          '0:00  Finding a schedule…',
          '0:19  Games per team settled (18.9 s)'
        ].join(FULL_LOG_BREAK)
        const full = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid]')
        ).find(node => node.dataset.testid === id)
        if (full == null) throw new Error('no full log')
        // No text, no label, no role: nothing for a screen reader to land on.
        expect(full.textContent).equals('')
        expect(full.getAttribute('aria-label')).equals(null)
        expect(full.getAttribute('role')).equals(null)
        expect(px(full, 'width')).equals(1)
        expect(px(full, 'height')).equals(1)
      } finally {
        if (os != null) Object.defineProperty(Platform, 'OS', os)
      }
    })

  describe('a build run in the modal', function () {
    const PREVIEW: SchedulePreview = {
      id: 'spv_built',
      leagueId: 'lea_1',
      mode: 'full',
      existing: null,
      status: 'open',
      createdAt: '2026-10-22T12:00:00.000Z',
      options: [],
      blocking: null,
      provenOptimal: true,
      edits: { option: 0, rejectedGameKeys: [], addedGames: [] },
      replacing: 0,
      publishedOption: null,
      publishedAt: null,
      published: [],
      teams: [],
      seasons: [],
      fields: []
    }
    let session: BuildSession | undefined
    let finish: ((answer: SchedulePreview | Error) => void) | undefined
    let outcome: Array<string | undefined> = []
    let runner: ((request: PreviewRequest) => void) | undefined
    let running = false

    const fake = {
      buildSchedulePreview: async (
        _leagueId: string,
        _request: PreviewRequest,
        given: BuildSession
      ) => {
        session = given
        return await new Promise<SchedulePreview>((resolve, reject) => {
          finish = answer => {
            if (answer instanceof Error) reject(answer)
            else resolve(answer)
          }
        })
      }
    } as unknown as TeamStationClient

    function Harness(): React.ReactElement {
      const build = useScheduleBuild(fake, 'lea_1')
      running = build.running
      runner = request => {
        build.run(request).then(
          preview => outcome.push(preview?.id ?? 'nothing'),
          (error: unknown) => outcome.push(`threw ${String(error)}`)
        )
      }
      return <>{build.modal}</>
    }

    async function start(): Promise<void> {
      outcome = []
      session = undefined
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => {
        root?.render(
          <ThemeProvider>
            <Harness />
          </ThemeProvider>
        )
      })
      await act(async () => {
        runner?.({ mode: 'full' })
      })
    }

    const modalShown = (): boolean =>
      document.querySelector('[data-testid="schedule-build-modal"]') != null

    it('logs each event with its time, and closes on the preview', async function () {
      await start()
      expect(running).equals(true)
      expect(shown()).includes('Building schedule')
      // A second build waits for the first.
      await act(async () => {
        runner?.({ mode: 'full' })
      })
      await act(async () => {
        session?.onProgress?.({ kind: 'phase', phase: 'preparing', ms: 400 })
        session?.onProgress?.({
          kind: 'progress',
          incumbentGames: 330,
          boundGames: 338,
          gap: 0.024
        })
      })
      expect(shown()).includes('0:00  Prepared (0.4 s)')
      expect(shown()).includes(
        'Found a schedule with 330 games — at most 338 possible (2.4%)'
      )
      await act(async () => {
        finish?.(PREVIEW)
      })
      expect(outcome).deep.equals(['nothing', 'spv_built'])
      expect(modalShown()).equals(false)
      expect(running).equals(false)
    })

    it('shows the upload’s end before closing, so a finished build’s full log ends with it', async function () {
      // What the drivers keep (e2e/rigs/schedule/autoScheduler.ts
      // WATCH_PAGE): the full log as each change to the page leaves it.
      let kept: string[] = []
      const watcher = new MutationObserver(() => {
        const full = document.querySelector(
          '[data-testid="schedule-build-log-full"]'
        )
        if (full != null) kept = (full.textContent ?? '').split('\n')
      })
      watcher.observe(document, {
        subtree: true,
        childList: true,
        characterData: true
      })
      try {
        await start()
        await act(async () => {
          session?.onProgress?.({ kind: 'phase', phase: 'preparing', ms: 400 })
          session?.onProgress?.({ kind: 'phase-start', phase: 'upload' })
        })
        // The upload's end comes just before the preview, in the same task.
        await act(async () => {
          session?.onProgress?.({ kind: 'phase', phase: 'upload', ms: 800 })
          finish?.(PREVIEW)
        })
        await act(async () => {})
        expect(outcome).deep.equals(['spv_built'])
        expect(modalShown()).equals(false)
        expect(kept[0]).equals(FULL_LOG)
        expect(kept.at(-1)).matches(/^0:00 {2}Saved \(0\.8 s\)$/)
      } finally {
        watcher.disconnect()
      }
    })

    it('hands nothing back when the screen goes away as the build closes', async function () {
      await start()
      await act(async () => {
        finish?.(PREVIEW)
        // The build has its preview and waits for the modal to show its end.
        for (let i = 0; i < 5; i++) await Promise.resolve()
        root?.unmount()
        root = undefined
      })
      await act(async () => {})
      expect(outcome).deep.equals(['nothing'])
    })

    it('at the limit goes on, uses the best found, or cancels', async function () {
      await start()
      const answers: string[] = []
      const limit = {
        kind: 'limit' as const,
        stage: 'targets' as const,
        bestGames: 330,
        boundGames: 338,
        solvedMs: 3000
      }
      const ask = async (): Promise<void> => {
        await act(async () => {
          session
            ?.onLimit?.(limit)
            .then(answer => answers.push(answer))
            .catch(() => undefined)
        })
      }
      await ask()
      expect(shown()).includes('Time limit reached')
      expect(shown()).includes('After 0:03 the solver hasn’t proven')
      await act(async () => {
        press('Continue processing')
      })
      expect(shown()).includes('Building schedule')
      await ask()
      await act(async () => {
        press('Use this schedule')
      })
      expect(shown()).includes('Building schedule')
      // With a best found, it is used as it is: nothing to wait for.
      expect(shown()).not.includes(AWAITING_FIRST)
      expect(shown()).not.includes(USING_FIRST)
      await ask()
      await act(async () => {
        press('Cancel')
      })
      expect(answers).deep.equals(['continue', 'use', 'cancel'])
      expect(session?.signal?.aborted).equals(true)
      expect(modalShown()).equals(false)
      // Nothing more is shown of a canceled build.
      await act(async () => {
        session?.onProgress?.({ kind: 'phase', phase: 'context', ms: 1 })
        finish?.(new EngineFailureError('canceled', 'The build was canceled'))
      })
      expect(modalShown()).equals(false)
      expect(outcome).deep.equals(['nothing'])
    })

    it('uses the first schedule found when the limit has none yet', async function () {
      await start()
      const answers: string[] = []
      await act(async () => {
        session
          ?.onLimit?.({
            kind: 'limit',
            stage: 'targets',
            bestGames: null,
            boundGames: 341,
            solvedMs: 3000
          })
          .then(answer => answers.push(answer))
          .catch(() => undefined)
      })
      expect(shown()).includes('hasn’t found a schedule yet')
      expect(buttons()).deep.equals([
        'Continue processing',
        'Use this schedule',
        'Cancel'
      ])
      await act(async () => {
        press('Use this schedule')
      })
      expect(answers).deep.equals(['use'])
      expect(shown()).includes('Building schedule')
      expect(shown()).includes(AWAITING_FIRST)
      expect(shown()).match(new RegExp(`0:0\\d  ${USING_FIRST}`))
      expect(buttons()).deep.equals(['Cancel'])
      // HiGHS's empty first incumbent is not a schedule to use.
      await act(async () => {
        session?.onProgress?.({
          kind: 'progress',
          incumbentGames: 0,
          boundGames: 341,
          gap: 1
        })
      })
      expect(shown()).includes(AWAITING_FIRST)
      await act(async () => {
        session?.onProgress?.({
          kind: 'progress',
          incumbentGames: 333,
          boundGames: 341,
          gap: 0.023
        })
      })
      expect(shown()).not.includes(AWAITING_FIRST)
      expect(shown()).includes('Found a schedule with 333 games')
      // Cancel is there throughout the wait.
      await act(async () => {
        press('Cancel')
      })
      expect(session?.signal?.aborted).equals(true)
      expect(modalShown()).equals(false)
    })

    it('ends the wait for a first schedule at the next step', async function () {
      await start()
      await act(async () => {
        session
          ?.onLimit?.({
            kind: 'limit',
            stage: 'targets',
            bestGames: null,
            boundGames: 341,
            solvedMs: 3000
          })
          .catch(() => undefined)
      })
      await act(async () => {
        press('Use this schedule')
      })
      expect(shown()).includes(AWAITING_FIRST)
      await act(async () => {
        session?.onProgress?.({ kind: 'phase', phase: 'targets', ms: 3100 })
      })
      expect(shown()).not.includes(AWAITING_FIRST)
      expect(shown()).includes('Games per team settled (3.1 s)')
    })

    describe('on a clock of the test’s own', function () {
      let scrolls: Array<{ top?: number; behavior?: string }> = []
      const scroll = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'scroll'
      )
      beforeEach(function () {
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 })
        scrolls = []
        Object.defineProperty(HTMLElement.prototype, 'scroll', {
          configurable: true,
          writable: true,
          value: (options?: ScrollToOptions | number) => {
            if (typeof options === 'object') scrolls.push(options)
          }
        })
      })
      afterEach(function () {
        mock.timers.reset()
        if (scroll == null)
          Reflect.deleteProperty(HTMLElement.prototype, 'scroll')
        else Object.defineProperty(HTMLElement.prototype, 'scroll', scroll)
      })
      const tick = async (ms: number): Promise<void> => {
        await act(async () => {
          mock.timers.tick(ms)
        })
      }
      const hear = async (event: BuildEvent): Promise<void> => {
        await act(async () => {
          session?.onProgress?.(event)
        })
      }
      /** Lays the log's lines out at `height`, as a browser reports it. */
      const laidOut = async (height: number): Promise<void> => {
        const content = box().firstElementChild as
          | (HTMLElement & {
              __reactLayoutHandler?: (event: unknown) => void
            })
          | null
        await act(async () => {
          content?.__reactLayoutHandler?.({
            nativeEvent: { layout: { x: 0, y: 0, width: 300, height } }
          })
        })
      }

      it('shows each step at once, its clock ticking each second, then its finished line in place with its time', async function () {
        await start()
        await hear({ kind: 'phase-start', phase: 'preparing' })
        expect(boxLines()).deep.equals(['0:00  Preparing…'])
        await tick(400)
        await hear({ kind: 'phase', phase: 'preparing', ms: 400 })
        // A step of no time still has its line.
        await hear({ kind: 'phase-start', phase: 'context' })
        await hear({ kind: 'phase', phase: 'context', ms: 0 })
        await hear({ kind: 'phase-start', phase: 'targets' })
        expect(boxLines()).deep.equals([
          '0:00  Prepared (0.4 s)',
          '0:00  Fields and dates read (0.0 s)',
          '0:00  Finding a schedule…'
        ])
        await tick(599)
        expect(boxLines()[2]).equals('0:00  Finding a schedule…')
        await tick(1)
        expect(boxLines()[2]).equals('0:01  Finding a schedule…')
        await tick(1000)
        expect(boxLines()[2]).equals('0:02  Finding a schedule…')
        await tick(7000)
        // A better schedule adds a line below; the step's line ticks on above.
        await hear({
          kind: 'progress',
          incumbentGames: 330,
          boundGames: 341,
          gap: 0.024
        })
        await tick(1000)
        expect(boxLines()).deep.equals([
          '0:00  Prepared (0.4 s)',
          '0:00  Fields and dates read (0.0 s)',
          '0:10  Finding a schedule…',
          '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)'
        ])
        await tick(9300)
        await hear({ kind: 'phase', phase: 'targets', ms: 18_900 })
        expect(boxLines()).deep.equals([
          '0:00  Prepared (0.4 s)',
          '0:00  Fields and dates read (0.0 s)',
          '0:19  Games per team settled (18.9 s)',
          '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)'
        ])
        // Nothing runs, so nothing ticks.
        await tick(5000)
        expect(boxLines()[2]).equals('0:19  Games per team settled (18.9 s)')
        expect(fullLog()).deep.equals([
          FULL_LOG,
          '0:00  Preparing…',
          '0:00  Prepared (0.4 s)',
          '0:00  Reading fields and dates…',
          '0:00  Fields and dates read (0.0 s)',
          '0:00  Finding a schedule…',
          '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)',
          '0:19  Games per team settled (18.9 s)'
        ])
        await act(async () => {
          finish?.(PREVIEW)
        })
        expect(modalShown()).equals(false)
      })

      it('stops its clock while waiting at the time limit, and goes on from there on Continue', async function () {
        await start()
        await hear({ kind: 'phase-start', phase: 'targets' })
        await tick(3000)
        const limit = {
          kind: 'limit' as const,
          stage: 'targets' as const,
          bestGames: 330,
          boundGames: 338,
          solvedMs: 3000
        }
        await hear(limit)
        await act(async () => {
          session?.onLimit?.(limit).catch(() => undefined)
        })
        expect(shown()).includes('Time limit reached')
        expect(boxLines()).deep.equals([
          '0:03  Finding a schedule…',
          '0:03  Time limit reached: best 330 games; at most 338 possible'
        ])
        // A minute's wait: the clock stays.
        await tick(60_000)
        expect(boxLines()[0]).equals('0:03  Finding a schedule…')
        await act(async () => {
          press('Continue processing')
        })
        await tick(1000)
        expect(boxLines()[0]).equals('0:04  Finding a schedule…')
        await tick(2000)
        await hear({ kind: 'phase', phase: 'targets', ms: 6000 })
        expect(boxLines()[0]).equals('0:06  Games per team settled (6.0 s)')
      })

      it('leaves no line ticking after a failure, and says the running step stopped', async function () {
        await start()
        await hear({ kind: 'phase-start', phase: 'targets' })
        await tick(2000)
        await act(async () => {
          finish?.(new Error('The model is too large.'))
        })
        expect(shown()).includes('The schedule couldn’t be built')
        await tick(5000)
        expect(boxLines()).deep.equals([
          '0:02  Finding a schedule — stopped (2.0 s)'
        ])
        expect(fullLog()).deep.equals([
          FULL_LOG,
          '0:00  Finding a schedule…',
          '0:02  Finding a schedule — stopped (2.0 s)'
        ])
      })

      it('ticks only the running lines, not the whole log, each second', async function () {
        const running = logReducer(startLog(T0), {
          type: 'event',
          event: { kind: 'phase-start', phase: 'targets' },
          at: T0
        })
        // Counts the full log's builds: one for each line logged.
        let builds = 0
        const transcript = [...running.transcript]
        const map = transcript.map.bind(transcript)
        transcript.map = ((...args: Parameters<typeof map>) => {
          builds++
          return map(...args)
        }) as typeof transcript.map
        await render({ kind: 'building' }, [], { ...running, transcript })
        expect(builds).equals(1)
        await tick(3000)
        expect(boxLines()).deep.equals(['0:03  Finding a schedule…'])
        expect(builds).equals(1)
        expect(fullLog()).deep.equals([FULL_LOG, '0:00  Finding a schedule…'])
      })

      /**
       * The box scrolled to `top`, as the browser reports it: an event the
       * box hears, past its 50 ms throttle.
       */
      const scrolledTo = async (
        node: HTMLElement,
        top: number
      ): Promise<void> => {
        node.scrollTop = top
        await act(async () => {
          node.dispatchEvent(new window.Event('scroll'))
        })
        await tick(60)
      }

      it('scrolls smoothly to each new line, and lets the admin read back until the next', async function () {
        await start()
        const room = px(box(), 'height')
        await laidOut(room)
        scrolls = []
        await hear({ kind: 'phase-start', phase: 'targets' })
        await laidOut(room + 20)
        expect(scrolls.length).greaterThan(0)
        for (const each of scrolls) expect(each.behavior).equals('smooth')
        // The box's own scroll reaches the foot, then the admin scrolls up
        // to read back.
        const node = box()
        Object.defineProperty(node, 'scrollHeight', {
          configurable: true,
          value: room + 200
        })
        Object.defineProperty(node, 'clientHeight', {
          configurable: true,
          value: room
        })
        await scrolledTo(node, 200)
        await scrolledTo(node, 40)
        // A line that grows in place leaves the admin where they are.
        scrolls = []
        await tick(1000)
        await laidOut(room + 40)
        expect(scrolls).deep.equals([])
        // A new line brings the box back to its foot, smoothly.
        await hear({
          kind: 'progress',
          incumbentGames: 330,
          boundGames: 341,
          gap: 0.024
        })
        await laidOut(room + 60)
        expect(scrolls.length).greaterThan(0)
        for (const each of scrolls) expect(each.behavior).equals('smooth')
      })

      it('stays at its foot through its own smooth scroll, so a line that grows there is followed', async function () {
        await start()
        const room = px(box(), 'height')
        await laidOut(room)
        await hear({ kind: 'phase-start', phase: 'targets' })
        await laidOut(room + 20)
        const node = box()
        Object.defineProperty(node, 'scrollHeight', {
          configurable: true,
          value: room + 200
        })
        Object.defineProperty(node, 'clientHeight', {
          configurable: true,
          value: room
        })
        // The smooth scroll down, short of the foot, as its scroll events
        // come in.
        await scrolledTo(node, 50)
        await scrolledTo(node, 120)
        // The step's line ends in place, longer, and wraps: the same lines,
        // taller.
        scrolls = []
        await hear({ kind: 'phase', phase: 'targets', ms: 900 })
        await laidOut(room + 40)
        expect(scrolls.length).greaterThan(0)
        for (const each of scrolls) expect(each.behavior).equals('smooth')
        // Scrolled up from there, it is left alone.
        await scrolledTo(node, 200)
        await scrolledTo(node, 150)
        scrolls = []
        await laidOut(room + 60)
        expect(scrolls).deep.equals([])
      })
    })

    it('closes on Cancel while building', async function () {
      await start()
      await act(async () => {
        press('Cancel')
      })
      expect(modalShown()).equals(false)
      await act(async () => {
        finish?.(new Error('stopped'))
      })
      expect(outcome).deep.equals(['nothing'])
    })

    it('enables Build again as soon as Cancel settles the build, as during a wait between uploads', async function () {
      await start()
      expect(running).equals(true)
      // The client settles at once on abort, even mid back-off
      // (api.scheduling.test.ts), so the modal's build ends with it.
      const given = session
      given?.signal?.addEventListener('abort', () =>
        finish?.(new EngineFailureError('canceled', 'The build was canceled'))
      )
      await act(async () => {
        press('Cancel')
      })
      expect(modalShown()).equals(false)
      expect(running).equals(false)
      expect(outcome).deep.equals(['nothing'])
      // A new build starts rather than being ignored.
      await act(async () => {
        runner?.({ mode: 'full' })
      })
      expect(session).not.equals(given)
      expect(running).equals(true)
      await act(async () => {
        finish?.(PREVIEW)
      })
      expect(outcome).deep.equals(['nothing', 'spv_built'])
    })

    it('hands back a build canceled after the server stored its result', async function () {
      await start()
      await act(async () => {
        press('Cancel')
      })
      // The result was already on its way, and the server kept it.
      await act(async () => {
        finish?.(PREVIEW)
      })
      expect(outcome).deep.equals(['spv_built'])
      expect(modalShown()).equals(false)
    })

    it('cancels a build whose screen goes away at the limit, and builds again after', async function () {
      await start()
      const answers: string[] = []
      await act(async () => {
        session
          ?.onLimit?.({
            kind: 'limit',
            stage: 'targets',
            bestGames: 330,
            boundGames: 338,
            solvedMs: 3000
          })
          .then(answer => answers.push(answer))
          .catch(() => undefined)
      })
      expect(shown()).includes('Time limit reached')
      const gone = session
      const finishGone = finish
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      expect(answers).deep.equals(['cancel'])
      expect(gone?.signal?.aborted).equals(true)
      // A preview that comes anyway opens nothing.
      await act(async () => {
        finishGone?.(PREVIEW)
      })
      expect(outcome).deep.equals(['nothing'])
      // The next screen's build runs as before.
      await start()
      expect(session).not.equals(gone)
      expect(running).equals(true)
      await act(async () => {
        finish?.(PREVIEW)
      })
      expect(outcome).deep.equals(['spv_built'])
      expect(running).equals(false)
    })

    it('closes when the engine answers canceled by itself', async function () {
      await start()
      await act(async () => {
        finish?.(new EngineFailureError('canceled', 'The build was canceled'))
      })
      expect(modalShown()).equals(false)
      expect(outcome).deep.equals(['nothing'])
    })

    it('says a device can’t run the scheduler, until closed', async function () {
      await start()
      await act(async () => {
        finish?.(
          new EngineFailureError('noSolver', 'This browser has no WebAssembly')
        )
      })
      expect(shown()).includes('This device can’t run the scheduler')
      expect(shown()).includes('This browser has no WebAssembly')
      expect(outcome).deep.equals(['nothing'])
      await act(async () => {
        press('Close')
      })
      expect(modalShown()).equals(false)
    })

    it('says a build failed, with its message or a plain one', async function () {
      await start()
      await act(async () => {
        finish?.(new EngineFailureError('broken', 'The model is too large'))
      })
      expect(shown()).includes('The schedule couldn’t be built')
      expect(shown()).includes('The model is too large')
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      await start()
      await act(async () => {
        finish?.(new Error(''))
      })
      expect(shown()).includes('Try again.')
    })

    it('hands a refusal with details back to the screen', async function () {
      await start()
      await act(async () => {
        finish?.(
          new HttpError('conflict', 'These seasons have games', {
            existingGames: 3
          })
        )
      })
      expect(modalShown()).equals(false)
      expect(outcome).deep.equals(['threw HttpError: These seasons have games'])
    })
  })
})
