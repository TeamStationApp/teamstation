import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

import { BASES } from '../../../../src/app/field/fieldModel'
import { defineHarness } from '../../../core/spec'
import { recordScreen } from '../../../core/video'
import { playEach, serveFixture } from '../../../rigs/scoring/fixturePage'

/**
 * Dictated outs on the production field, in Safari on an iPhone. Each
 * scenario of `src/test/dictatedOuts.fixture.tsx`, served on the stack's
 * pages site (`rigs/scoring/fixturePage.ts`), is played to completion while
 * maestro-d records the screen; the fixture reports every picture and
 * runner motion, and the middle of each named throw is logged against the
 * recording.
 */

const F = { P: 10, C: 11, B1: 12, B2: 13, SS: 14, B3: 15, LF: 16 }
const RUNNER = 5
/** The leadoff batter of the fixture's game. */
const BATTER = 1

interface Picture {
  type: 'picture'
  at: number
  end?: number
  kind: string
  stage: string
  durationMs: number
  thrower?: number
  receiver?: number
  runner?: number
  to?: { x: number; z: number }
  runnerFrom?: { x: number; z: number }
  unassisted?: boolean
  safe?: boolean
}
interface Motion {
  type: 'motion'
  at: number
  playerId: number
  first: { x: number; z: number }
  last: { x: number; z: number }
}
interface Report {
  name: string
  outs: number
  bases: Record<'first' | 'second' | 'third', number | null>
  timeline: Array<Picture | Motion>
}
interface Expected {
  throws: string[]
  outs: number
  /** Frames to pull: a throw by its index among the throws, and when. */
  frames: Array<{ file: string; throw: number; at: 'mid' | 'walkoff' }>
}
const ground = (point: { x: number; z: number }): { x: number; z: number } => ({
  x: Math.round(point.x * 1000) / 1000,
  z: Math.round(point.z * 1000) / 1000
})
const tag = (from: number, to: number): string => `${from}>${to}:tag`
const EXPECTED: Record<string, Expected> = {
  E1: {
    throws: [tag(F.SS, F.B1)],
    outs: 1,
    frames: [{ file: 'e1-throw-mid', throw: 0, at: 'mid' }]
  },
  E2: {
    throws: [tag(F.SS, F.B2), tag(F.B2, F.B1)],
    outs: 2,
    frames: [
      { file: 'e2-throw1-mid', throw: 0, at: 'mid' },
      { file: 'e2-walkoff', throw: 0, at: 'walkoff' },
      { file: 'e2-throw2-mid', throw: 1, at: 'mid' }
    ]
  },
  E3: {
    throws: [tag(F.LF, F.SS)],
    outs: 2,
    frames: [{ file: 'e3-throw-mid', throw: 0, at: 'mid' }]
  },
  E4: {
    throws: [tag(F.B1, F.P)],
    outs: 1,
    frames: [{ file: 'e4-throw-mid', throw: 0, at: 'mid' }]
  },
  E5: { throws: [tag(F.B3, F.B2)], outs: 1, frames: [] },
  E6: {
    throws: [`${F.B3}>${F.B2}:transfer:safe`, `${F.B2}>${F.B1}:transfer:safe`],
    outs: 0,
    frames: []
  },
  E7: {
    throws: [tag(F.C, F.SS)],
    outs: 1,
    frames: [{ file: 'e7-throw-mid', throw: 0, at: 'mid' }]
  },
  E8: {
    throws: [`${tag(F.B3, F.B3)}:unassisted`],
    outs: 1,
    frames: [{ file: 'e8-walkoff', throw: 0, at: 'walkoff' }]
  }
}
const named = (p: Picture): string =>
  `${p.thrower}>${p.receiver}:${p.stage}${p.unassisted === true ? ':unassisted' : ''}${p.safe === true ? ':safe' : ''}`

/** Every tag's runner walks off from the base he was tagged at. */
function checkWalkOffs(report: Report, throws: Picture[]): void {
  for (const thrown of throws.filter(t => t.stage === 'tag')) {
    const walk = report.timeline.find(
      (entry): entry is Motion =>
        entry.type === 'motion' &&
        entry.playerId === thrown.runner &&
        entry.at >= thrown.at - 50
    )
    assert(walk != null, `${report.name}: no walk off for ${thrown.runner}`)
    assert.deepEqual(walk.first, thrown.to, `${report.name}: walk-off start`)
    assert.deepEqual(
      [Math.abs(walk.last.x), walk.last.z],
      [32, 6],
      `${report.name}: walk-off end`
    )
  }
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export default defineHarness({
  id: 'scoring/dictated-plays/outs',
  title:
    'Dictated outs draw runner and ball arriving together, then walk off from the tag base',
  kind: 'e2e',
  covers: [
    'src/app/scoring/dictatedCompletion.ts',
    'src/app/scoring/scoringMachine.ts',
    'src/app/scoring/scoringMotion.ts',
    'src/app/scoring/scoringPresentation.ts',
    'src/app/field/BaseballScreen.tsx',
    'src/test/dictatedOuts.fixture.tsx'
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
    'out-drawn-then-walk-off': async ctx => {
      const fixture = await serveFixture(
        ctx,
        'src/test/dictatedOuts.fixture.tsx',
        []
      )
      const m = await ctx.mobileBrowser('phone', fixture.url)
      await m.assertVisible({ text: '^Play E1$', timeout: 60000 })
      // Let the field finish loading before anything is timed against it.
      await sleep(3000)
      let reports = new Map<string, Report>()
      const recording = await recordScreen(
        m,
        ctx.runDir,
        'after-plays',
        async () => {
          reports = await playEach(m, fixture, Object.keys(EXPECTED), 1500)
        }
      )
      const zero = recording.startedAtMs
      const lines: string[] = []
      const failures: string[] = []
      for (const [name, expected] of Object.entries(EXPECTED)) {
        const report = reports.get(name)!
        const pictures = report.timeline.filter(
          (entry): entry is Picture => entry.type === 'picture'
        )
        const throws = pictures.filter(p => p.kind === 'throw')
        lines.push(
          `${name}: ${pictures.map(p => (p.kind === 'throw' ? named(p) : p.kind)).join(', ')}; outs ${report.outs}`
        )
        for (const entry of report.timeline)
          if (entry.type === 'picture' && entry.kind === 'throw')
            lines.push(
              `  throw ${named(entry)} runner ${entry.runner} from ${JSON.stringify(entry.runnerFrom)} to ${JSON.stringify(entry.to)} ${Math.round(entry.durationMs)}ms`
            )
          else if (entry.type === 'motion')
            lines.push(
              `  motion ${entry.playerId} ${JSON.stringify(entry.first)} -> ${JSON.stringify(entry.last)}`
            )
        for (const frame of expected.frames) {
          const thrown = throws[frame.throw]
          if (thrown == null) continue
          const at =
            frame.at === 'mid'
              ? thrown.at + thrown.durationMs / 2
              : (thrown.end ?? thrown.at + thrown.durationMs) + 300
          lines.push(
            `  frame ${frame.file}-after at ${Math.round(at - zero)}ms of after-plays.mp4`
          )
        }
        try {
          assert.deepEqual(throws.map(named), expected.throws, `${name} throws`)
          assert.equal(report.outs, expected.outs, `${name} outs`)
          // He runs inside the picture: it starts him short of the base. A
          // fielder's choice runs him there with the hit, before its throw.
          if (name !== 'E5')
            for (const thrown of throws.filter(t => t.stage === 'tag'))
              assert.notDeepEqual(thrown.runnerFrom, thrown.to, `${name} run`)
          checkWalkOffs(report, throws)
          // The hit runs an out batter toward first: the tag, or his trot after
          // a catch, takes him on from there, never from the plate again.
          const offPlate = (point?: { z: number }): boolean =>
            point != null && point.z < -1
          // Nor does it run him to the bag ahead of the ball: the tag still
          // has ground for him to cover.
          for (const thrown of throws.filter(
            t => t.runner === BATTER && t.stage === 'tag'
          )) {
            assert(offPlate(thrown.runnerFrom), `${name} batter restarts`)
            const left = Math.hypot(
              thrown.to!.x - thrown.runnerFrom!.x,
              thrown.to!.z - thrown.runnerFrom!.z
            )
            assert(left > 5, `${name} batter beats the ball`)
          }
          if (name === 'E3') {
            const trot = report.timeline.find(
              (entry): entry is Motion =>
                entry.type === 'motion' && entry.playerId === BATTER
            )
            assert(offPlate(trot?.first), 'E3 batter trot restarts')
          }
          if (name === 'E2' || name === 'E5' || name === 'E7')
            assert.deepEqual(throws[0].to, ground(BASES[2]), `${name} tag base`)
          if (name === 'E6')
            assert.deepEqual(
              [report.bases.first != null, report.bases.second],
              [true, RUNNER],
              'E6 runners'
            )
          lines.push(`  PASS ${name}`)
        } catch (error) {
          failures.push(`${name}: ${(error as Error).message}`)
          lines.push(`  FAIL ${name}: ${(error as Error).message}`)
        }
      }
      writeFileSync(ctx.artifact('dictated-outs.log'), lines.join('\n') + '\n')
      assert.deepEqual(failures, [], failures.join('\n'))
    }
  }
})
