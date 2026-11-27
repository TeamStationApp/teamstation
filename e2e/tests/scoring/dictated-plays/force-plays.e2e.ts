import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

import { defineHarness } from '../../../core/spec'
import { recordScreen } from '../../../core/video'
import { playEach, serveFixture } from '../../../rigs/scoring/fixturePage'

/**
 * Dictated force plays, the third out and the pitch before a ball in play,
 * in Safari on an iPhone. Each scenario of
 * `src/test/dictatedForcePlays.fixture.tsx`, served on the stack's pages
 * site (`rigs/scoring/fixturePage.ts`), is played to completion while
 * maestro-d records the screen; the fixture reports each picture and how
 * the play ended. The moments the named frames show are logged against the
 * recording.
 */

const F = { SS: 14, B1: 12, B3: 15 }
/** The runner the F2 sentence leaves on first, forced to second. */
const FIRST = 5

interface Picture {
  type: 'picture'
  at: number
  end?: number
  kind: string
  stage: string
  durationMs: number
  contactMs?: number
  pitched?: boolean
  thrower?: number
  receiver?: number
  runner?: number
  unassisted?: boolean
  safe?: boolean
  wild?: boolean
}
interface Report {
  name: string
  outs: number
  top: boolean
  runs: number
  errors: number
  bases: Record<'first' | 'second' | 'third', number | null>
  note: string | null
  /** What the screen asked, or why it refused, when it did not apply it. */
  unapplied: string | null
  timeline: Picture[]
  /** When the driver had the report: the play's end when it drew nothing. */
  reportedAt: number
}
/** A frame: at a moment of a picture, or after the play; `after` only once fixed. */
interface Frame {
  file: string
  picture?: number
  at: 'mid' | 'pass' | 'done' | number
  afterOnly?: boolean
}
interface Expected {
  pictures: string[]
  check: (report: Report) => void
  frames: Frame[]
}
const carry = (fielder: number): string => `${fielder}>${fielder}:unassisted`
const named = (p: Picture): string =>
  p.kind !== 'throw'
    ? p.kind
    : `${p.thrower}>${p.receiver}${p.unassisted === true ? ':unassisted' : ''}${p.wild === true ? ':wild' : ''}`
const EXPECTED: Record<string, Expected> = {
  F1: {
    pictures: ['hit', carry(F.SS)],
    check: report => {
      assert.equal(report.outs, 2, 'F1 outs')
      assert.notEqual(report.bases.first, null, 'F1 batter on first')
      assert.equal(report.bases.second, null, 'F1 second empty')
    },
    frames: [{ file: 'f1-force-second', picture: 1, at: 'mid' }]
  },
  F2: {
    pictures: ['hit', carry(F.B3)],
    check: report => {
      assert.equal(report.outs, 1, 'F2 outs')
      assert.notEqual(report.bases.first, null, 'F2 batter on first')
      assert.equal(report.bases.second, FIRST, 'F2 runner from first on second')
    },
    frames: [{ file: 'f2-force-third', picture: 1, at: 'mid' }]
  },
  F3: {
    pictures: ['hit', carry(F.SS), `${F.SS}>${F.B1}:wild`],
    check: report => {
      assert.equal(report.outs, 1, 'F3 outs')
      assert.equal(report.errors, 1, 'F3 error')
      assert.notEqual(report.bases.first, null, 'F3 batter on first')
    },
    frames: [{ file: 'f3-overthrow', picture: 2, at: 'pass' }]
  },
  F4: {
    pictures: ['hit', carry(F.SS)],
    check: report => {
      assert.equal(report.top, false, 'F4 half ended')
      assert.equal(report.errors, 0, 'F4 no error')
      assert.match(
        report.note ?? '',
        /^Left out after the third out: the error by /
      )
    },
    frames: [{ file: 'f4-third-out', at: 'done' }]
  },
  F5: {
    pictures: ['hit'],
    check: report => {
      assert.equal(report.top, false, 'F5 half ended')
      assert.equal(report.runs, 0, 'F5 no run')
      assert.match(report.note ?? '', /scoring$/)
    },
    frames: [{ file: 'f5-no-run', at: 'done' }]
  },
  F6: {
    pictures: ['hit'],
    check: report => {
      const hit = report.timeline[0]
      assert.equal(hit.contactMs, 1050, 'F6 contact at the plate')
      assert.equal(hit.pitched, true, 'F6 pitched')
    },
    frames: [
      { file: 'f6-windup', picture: 0, at: 300 },
      { file: 'f6-pitch', picture: 0, at: 850, afterOnly: true },
      { file: 'f6-contact', picture: 0, at: 1050, afterOnly: true }
    ]
  },
  F7: {
    pictures: ['hit'],
    check: report => {
      assert.equal(
        report.timeline[0].contactMs,
        1050,
        'F7 contact at the plate'
      )
    },
    frames: [{ file: 'f7-bunt', picture: 0, at: 'mid' }]
  }
}

/** When a frame is: a picture's middle, the wild ball passing the bag, its contact, or after the play. */
function frameAt(frame: Frame, report: Report): number {
  const pictures = report.timeline
  const last = pictures.at(-1)
  const done =
    last == null
      ? report.reportedAt + 800
      : (last.end ?? last.at + last.durationMs) + 800
  if (frame.at === 'done') return done
  const picture = pictures[frame.picture ?? 0]
  if (picture == null) return done
  if (frame.file === 'f7-bunt') return picture.at + (picture.contactMs ?? 450)
  if (frame.at === 'mid') return picture.at + picture.durationMs / 2
  if (frame.at === 'pass') return picture.at + picture.durationMs * 0.75
  return picture.at + frame.at
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export default defineHarness({
  id: 'scoring/dictated-plays/force-plays',
  title:
    'Dictated force plays, third outs and pitched balls in play are drawn and scored as said',
  kind: 'e2e',
  covers: [
    'src/app/scoring/dictatedCompletion.ts',
    'src/app/scoring/scoringMachine.ts',
    'src/app/scoring/scoringPresentation.ts',
    'src/app/field/BaseballScreen.tsx',
    'src/test/dictatedForcePlays.fixture.tsx'
  ],
  stack: 'isolated',
  fixtures: [],
  // The page is served on the stack's pages stand-in, whose one script
  // this run replaces.
  exclusive: true,
  surfaces: {
    'web-safari-ios': {
      // The field draws in 3D: a GPU, so a physical iPhone.
      devices: [
        { role: 'phone', needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'drawn-and-scored-as-said': async ctx => {
      const fixture = await serveFixture(
        ctx,
        'src/test/dictatedForcePlays.fixture.tsx',
        []
      )
      const m = await ctx.mobileBrowser('phone', fixture.url)
      await m.assertVisible({ text: '^Play F1$', timeout: 60000 })
      // Let the field finish loading before anything is timed against it.
      await sleep(3000)
      let reports = new Map<string, Report>()
      const recording = await recordScreen(
        m,
        ctx.runDir,
        'after-plays',
        async () => {
          reports = await playEach(m, fixture, Object.keys(EXPECTED), 2000)
        }
      )
      const zero = recording.startedAtMs
      const lines: string[] = []
      const failures: string[] = []
      for (const [name, expected] of Object.entries(EXPECTED)) {
        const report = reports.get(name)!
        lines.push(
          `${name}: ${report.timeline.map(named).join(', ')}; ${report.top ? 'top' : 'bottom'}, outs ${report.outs}, runs ${report.runs}, errors ${report.errors}, bases ${JSON.stringify(report.bases)}, note ${JSON.stringify(report.note)}, unapplied ${JSON.stringify(report.unapplied)}`
        )
        for (const picture of report.timeline)
          lines.push(
            `  ${named(picture)} ${Math.round(picture.durationMs)}ms${picture.contactMs == null ? '' : ` contact ${picture.contactMs}ms${picture.pitched === true ? ', pitched' : ''}`}`
          )
        // Where each named frame is in the recording (the phone's clock
        // against this machine's, so to a few tens of milliseconds).
        for (const frame of expected.frames)
          lines.push(
            `  frame ${frame.file}-after at ${Math.round(frameAt(frame, report) - zero)}ms of after-plays.mp4`
          )
        try {
          assert.deepEqual(
            report.timeline.map(named),
            expected.pictures,
            `${name} pictures`
          )
          assert.equal(report.unapplied, null, `${name} applied`)
          expected.check(report)
          lines.push(`  PASS ${name}`)
        } catch (error) {
          failures.push(`${name}: ${(error as Error).message}`)
          lines.push(`  FAIL ${name}: ${(error as Error).message}`)
        }
      }
      writeFileSync(
        ctx.artifact('dictated-force-plays.log'),
        lines.join('\n') + '\n'
      )
      assert.deepEqual(failures, [], failures.join('\n'))
    }
  }
})
