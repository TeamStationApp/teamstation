import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { BuildEvent } from '../../common/schedulePreviews'
import {
  type BuildLog,
  type BuildLogAction,
  clockText,
  eventText,
  limitText,
  lineText,
  logClock,
  logReducer,
  runningText,
  startLog,
  stoppedText,
  ticking
} from './buildLog'

/** The build's log after each action, from a start at 1,000,000 ms. */
const T0 = 1_000_000
function logAfter(...actions: BuildLogAction[]): BuildLog {
  return actions.reduce(logReducer, startLog(T0))
}
const event = (at: number, built: BuildEvent): BuildLogAction => ({
  type: 'event',
  event: built,
  at: T0 + at
})
const shown = (log: BuildLog): string[] => log.lines.map(lineText)
const logged = (log: BuildLog): string[] => log.transcript.map(lineText)

describe('the schedule build log', () => {
  it('times lines in minutes and seconds from the start', () => {
    expect(clockText(0)).equals('0:00')
    expect(clockText(3400)).equals('0:03')
    expect(clockText(120000)).equals('2:00')
    expect(clockText(725000)).equals('12:05')
    expect(clockText(-5)).equals('0:00')
  })

  it('says what each step did and how long it took', () => {
    expect(
      eventText({
        kind: 'phase',
        phase: 'model',
        ms: 1234,
        detail: { columns: 23776, rows: 10685 }
      })
    ).equals('Model: 23,776 possible games, 10,685 rules (1.2 s)')
    expect(
      eventText({
        kind: 'phase',
        phase: 'model',
        ms: 1234,
        detail: { columns: 5 }
      })
    ).equals('Model: 5 possible games, 0 rules (1.2 s)')
    expect(eventText({ kind: 'phase', phase: 'targets', ms: 8000 })).equals(
      'Games per team settled (8.0 s)'
    )
    expect(
      eventText({
        kind: 'phase',
        phase: 'cause',
        ms: 500,
        detail: { seasonName: 'Spring 12U' }
      })
    ).equals('Shortfall explained: Spring 12U (0.5 s)')
    expect(eventText({ kind: 'phase', phase: 'cause', ms: 0 })).equals(
      'Shortfall explained (0.0 s)'
    )
    expect(eventText({ kind: 'phase', phase: 'preparing', ms: 400 })).equals(
      'Prepared (0.4 s)'
    )
    expect(eventText({ kind: 'phase', phase: 'upload', ms: 250 })).equals(
      'Saved (0.3 s)'
    )
  })

  it('reports the solver’s best schedule and how far it can still be from the best', () => {
    expect(
      lineText({
        atMs: 9100,
        text: eventText({
          kind: 'progress',
          incumbentGames: 330,
          boundGames: 338,
          gap: 0.024
        })
      })
    ).equals(
      '0:09  Found a schedule with 330 games — at most 338 possible (2.4%)'
    )
  })

  it('logs each time limit, with or without a schedule found', () => {
    const limit = {
      kind: 'limit' as const,
      stage: 'targets' as const,
      boundGames: 338,
      solvedMs: 3000
    }
    expect(eventText({ ...limit, bestGames: 330 })).equals(
      'Time limit reached: best 330 games; at most 338 possible'
    )
    expect(eventText({ ...limit, bestGames: null })).equals(
      'Time limit reached: no schedule yet; at most 338 games possible'
    )
  })

  it('words the limit by the solve time so far', () => {
    expect(
      limitText({ solvedMs: 120000, bestGames: 330, boundGames: 338 })
    ).equals(
      'After 2:00 the solver hasn’t proven this is the best schedule. Best found: 330 games; at most 338 possible.'
    )
    expect(
      limitText({ solvedMs: 240500, bestGames: 1336, boundGames: 1338 })
    ).equals(
      'After 4:00 the solver hasn’t proven this is the best schedule. Best found: 1,336 games; at most 1,338 possible.'
    )
    expect(
      limitText({ solvedMs: 3200, bestGames: null, boundGames: 338 })
    ).equals(
      'After 0:03 the solver hasn’t found a schedule yet; at most 338 games possible.'
    )
  })

  it('words each step while it runs', () => {
    expect(
      (
        [
          'preparing',
          'context',
          'model',
          'targets',
          'placement',
          'cause',
          'polish',
          'options',
          'upload'
        ] as const
      ).map(phase => runningText({ kind: 'phase-start', phase }))
    ).deep.equals([
      'Preparing…',
      'Reading fields and dates…',
      'Building the model…',
      'Finding a schedule…',
      'Placing games…',
      'Explaining the shortfall…',
      'Polishing options…',
      'Choosing options…',
      'Saving…'
    ])
    expect(
      eventText({
        kind: 'phase-start',
        phase: 'cause',
        detail: { seasonName: 'S5' }
      })
    ).equals('Explaining S5’s shortfall…')
  })

  describe('as the modal keeps it', () => {
    it('starts empty, with its clock at the build’s start', () => {
      const log = startLog(T0)
      expect(log.lines).deep.equals([])
      expect(log.transcript).deep.equals([])
      expect(logClock(log, T0 + 1500)).equals(1500)
      expect(logClock(log, T0 - 5)).equals(0)
      expect(ticking(log)).equals(false)
    })

    it('shows a step running at once, its clock ticking, then its finished line in the same place', () => {
      const started = logAfter(
        event(0, { kind: 'phase-start', phase: 'targets' })
      )
      expect(shown(started)).deep.equals(['0:00  Finding a schedule…'])
      expect(ticking(started)).equals(true)
      const ticked = logReducer(started, { type: 'tick', at: T0 + 2100 })
      expect(shown(ticked)).deep.equals(['0:02  Finding a schedule…'])
      // A tick at the same or an earlier time changes nothing.
      expect(logReducer(ticked, { type: 'tick', at: T0 + 2100 })).equals(ticked)
      expect(
        shown(logReducer(ticked, { type: 'tick', at: T0 + 1000 }))
      ).deep.equals(['0:02  Finding a schedule…'])
      const better = logReducer(
        ticked,
        event(9000, {
          kind: 'progress',
          incumbentGames: 330,
          boundGames: 341,
          gap: 0.024
        })
      )
      expect(shown(better)).deep.equals([
        '0:02  Finding a schedule…',
        '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)'
      ])
      const later = logReducer(better, { type: 'tick', at: T0 + 12_000 })
      expect(shown(later)[0]).equals('0:12  Finding a schedule…')
      const done = logReducer(
        later,
        event(19_300, { kind: 'phase', phase: 'targets', ms: 19_300 })
      )
      expect(shown(done)).deep.equals([
        '0:19  Games per team settled (19.3 s)',
        '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)'
      ])
      expect(ticking(done)).equals(false)
      expect(logReducer(done, { type: 'tick', at: T0 + 30_000 })).equals(done)
      // Every line as it was logged: the start, the better schedule, the end.
      expect(logged(done)).deep.equals([
        '0:00  Finding a schedule…',
        '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)',
        '0:19  Games per team settled (19.3 s)'
      ])
    })

    it('keeps each season’s cause apart, and a step of no time still gets its line', () => {
      const log = logAfter(
        event(100, {
          kind: 'phase-start',
          phase: 'cause',
          detail: { seasonName: 'S5' }
        }),
        event(5100, {
          kind: 'phase',
          phase: 'cause',
          ms: 5000,
          detail: { seasonName: 'S5' }
        }),
        event(5100, {
          kind: 'phase-start',
          phase: 'cause',
          detail: { seasonName: 'S6' }
        }),
        event(5100, {
          kind: 'phase',
          phase: 'cause',
          ms: 0,
          detail: { seasonName: 'S6' }
        })
      )
      expect(shown(log)).deep.equals([
        '0:05  Shortfall explained: S5 (5.0 s)',
        '0:05  Shortfall explained: S6 (0.0 s)'
      ])
      expect(logged(log)).deep.equals([
        '0:00  Explaining S5’s shortfall…',
        '0:05  Shortfall explained: S5 (5.0 s)',
        '0:05  Explaining S6’s shortfall…',
        '0:05  Shortfall explained: S6 (0.0 s)'
      ])
    })

    it('adds a finished step it never saw start, as before', () => {
      expect(
        shown(
          logAfter(event(400, { kind: 'phase', phase: 'preparing', ms: 400 }))
        )
      ).deep.equals(['0:00  Prepared (0.4 s)'])
    })

    it('stops a step that never said it ended when the next starts', () => {
      const log = logAfter(
        event(0, { kind: 'phase-start', phase: 'model' }),
        event(1500, { kind: 'phase-start', phase: 'targets' }),
        { type: 'tick', at: T0 + 3000 }
      )
      expect(shown(log)).deep.equals([
        '0:01  Building the model…',
        '0:03  Finding a schedule…'
      ])
    })

    it('finishes a stopped step’s line in place when its end comes late', () => {
      const late = logAfter(
        event(0, { kind: 'phase-start', phase: 'model' }),
        event(1500, { kind: 'phase-start', phase: 'targets' }),
        event(1600, { kind: 'phase', phase: 'model', ms: 1600 }),
        { type: 'tick', at: T0 + 3000 }
      )
      expect(shown(late)).deep.equals([
        '0:01  Model (1.6 s)',
        '0:03  Finding a schedule…'
      ])
      expect(late.lines[1].step).equals('targets')
      expect(logged(late)).deep.equals([
        '0:00  Building the model…',
        '0:01  Finding a schedule…',
        '0:01  Model (1.6 s)'
      ])
      // After the build stops, too; a cause by its season.
      const stopped = logAfter(
        event(0, {
          kind: 'phase-start',
          phase: 'cause',
          detail: { seasonName: 'S5' }
        }),
        { type: 'stop', at: T0 + 2000 },
        event(2100, {
          kind: 'phase',
          phase: 'cause',
          ms: 2100,
          detail: { seasonName: 'S5' }
        })
      )
      expect(shown(stopped)).deep.equals([
        '0:02  Shortfall explained: S5 (2.1 s)'
      ])
      expect(ticking(stopped)).equals(false)
      // A step started again ends its latest line.
      const again = logAfter(
        event(0, { kind: 'phase-start', phase: 'targets' }),
        event(1000, { kind: 'phase-start', phase: 'model' }),
        event(2000, { kind: 'phase-start', phase: 'targets' }),
        event(3000, { kind: 'phase', phase: 'targets', ms: 1000 })
      )
      expect(shown(again)).deep.equals([
        '0:01  Finding a schedule…',
        '0:02  Building the model…',
        '0:03  Games per team settled (1.0 s)'
      ])
    })

    it('stops its clock at a time limit, and goes on from there on Continue', () => {
      const limit: BuildEvent = {
        kind: 'limit',
        stage: 'targets',
        bestGames: 330,
        boundGames: 338,
        solvedMs: 3000
      }
      const paused = logAfter(
        event(0, { kind: 'phase-start', phase: 'targets' }),
        event(3000, limit)
      )
      expect(shown(paused)).deep.equals([
        '0:03  Finding a schedule…',
        '0:03  Time limit reached: best 330 games; at most 338 possible'
      ])
      expect(ticking(paused)).equals(false)
      // A minute's wait for the answer: the clock stays.
      expect(logReducer(paused, { type: 'tick', at: T0 + 63_000 })).equals(
        paused
      )
      expect(logClock(paused, T0 + 63_000)).equals(3000)
      // The session's own pause at the same limit changes nothing more.
      expect(logReducer(paused, { type: 'pause', at: T0 + 4000 })).equals(
        paused
      )
      const resumed = logReducer(paused, { type: 'resume', at: T0 + 63_000 })
      expect(ticking(resumed)).equals(true)
      expect(logClock(resumed, T0 + 64_000)).equals(4000)
      expect(logReducer(resumed, { type: 'resume', at: T0 + 70_000 })).equals(
        resumed
      )
      const ticked = logReducer(resumed, { type: 'tick', at: T0 + 64_000 })
      expect(shown(ticked)[0]).equals('0:04  Finding a schedule…')
      const noted = logReducer(ticked, {
        type: 'note',
        text: 'Using the first schedule found',
        at: T0 + 65_000
      })
      expect(shown(noted).at(-1)).equals('0:05  Using the first schedule found')
      const done = logReducer(
        noted,
        event(80_000, { kind: 'phase', phase: 'targets', ms: 20_000 })
      )
      expect(shown(done)[0]).equals('0:20  Games per team settled (20.0 s)')
    })

    it('leaves no line running once the build stops', () => {
      const running = logAfter(
        event(0, { kind: 'phase-start', phase: 'polish' })
      )
      const stopped = logReducer(running, { type: 'stop', at: T0 + 2500 })
      expect(ticking(stopped)).equals(false)
      // It says it stopped, and after how long: never its running wording.
      expect(shown(stopped)).deep.equals([
        '0:02  Polishing options — stopped (2.5 s)'
      ])
      expect(logged(stopped)).deep.equals([
        '0:00  Polishing options…',
        '0:02  Polishing options — stopped (2.5 s)'
      ])
      expect(stopped.lines[0].step).equals(undefined)
      expect(stopped.lines[0].stopped).equals('polish')
      expect(logReducer(stopped, { type: 'stop', at: T0 + 3000 })).equals(
        stopped
      )
      expect(logReducer(stopped, { type: 'tick', at: T0 + 9000 })).equals(
        stopped
      )
    })

    it('says each step whose end never came stopped, with how long it ran, when the build fails', () => {
      const failed = logAfter(
        event(0, { kind: 'phase', phase: 'preparing', ms: 400 }),
        event(1000, { kind: 'phase-start', phase: 'model' }),
        // The model's end never comes: the next step's start stops its line.
        event(2500, { kind: 'phase-start', phase: 'targets' }),
        event(9000, {
          kind: 'progress',
          incumbentGames: 330,
          boundGames: 341,
          gap: 0.024
        }),
        { type: 'stop', at: T0 + 14_500 }
      )
      expect(shown(failed)).deep.equals([
        '0:00  Prepared (0.4 s)',
        '0:02  Building the model — stopped (1.5 s)',
        '0:14  Finding a schedule — stopped (12.0 s)',
        '0:09  Found a schedule with 330 games — at most 341 possible (2.4%)'
      ])
      expect(logged(failed).slice(-2)).deep.equals([
        '0:02  Building the model — stopped (1.5 s)',
        '0:14  Finding a schedule — stopped (12.0 s)'
      ])
      expect(failed.lines.every(line => line.fromMs == null)).equals(true)
      // A cause by its season.
      expect(
        shown(
          logAfter(
            event(0, {
              kind: 'phase-start',
              phase: 'cause',
              detail: { seasonName: 'S5' }
            }),
            { type: 'stop', at: T0 + 3000 }
          )
        )
      ).deep.equals(['0:03  Explaining S5’s shortfall — stopped (3.0 s)'])
    })

    it('words every step’s stopped line alike', () => {
      const phases = [
        'preparing',
        'context',
        'model',
        'targets',
        'placement',
        'cause',
        'polish',
        'options',
        'upload'
      ] as const
      for (const phase of phases) {
        const running = runningText({ kind: 'phase-start', phase })
        expect(running).matches(/…$/)
        const stopped = stoppedText(running, 1234)
        expect(stopped).equals(`${running.slice(0, -1)} — stopped (1.2 s)`)
        expect(stopped).not.includes('…')
      }
      expect(stoppedText('Saving…', -5)).equals('Saving — stopped (0.0 s)')
    })
  })
})
