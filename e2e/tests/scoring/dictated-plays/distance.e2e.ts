import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

import type { ScoringAction } from '../../../../src/common/scoring/actions'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { recordScreen } from '../../../core/video'
import { playEach, serveFixture } from '../../../rigs/scoring/fixturePage'

/**
 * Where dictated balls and pitches went, on the production field, in Safari
 * on an iPhone. Each scenario's sentences are first put to the real
 * interpreter (Claude Haiku 5.5, through Anthropic's messages, with the
 * caller's `anthropic` key), as `dictatedDistance.integration.ts` puts them;
 * what it said is played by `src/test/dictatedDistance.fixture.tsx`, served
 * on the stack's pages site (`rigs/scoring/fixturePage.ts`), while
 * maestro-d records the screen. The fixture reports where each ball came
 * down and what was stored, and the moment each ball comes down is logged
 * against the recording.
 */

interface Point {
  x: number
  z: number
}
interface Picture {
  at: number
  end?: number
  kind: string
  durationMs: number
  landsMs: number
  lands?: Point
  landingHeight?: number | null
  carom?: Point
  foul?: Point
}
interface Report {
  name: string
  outs: number
  count: { balls: number; strikes: number }
  stored: {
    coordinates: Point | null
    pitches: Array<{
      call: string
      type: { code: string } | null
      pitchData: { location?: unknown } | null
    }>
  }
  timeline: Picture[]
}
interface Scenario {
  name: string
  said: string
  actions: ScoringAction[]
}
/** Each scenario's sentences, as the integration run heard them. */
const SCENARIOS: Array<{ name: string; frame: string; said: string[] }> = [
  {
    name: 'E1',
    frame: 'e1-bloop',
    said: ['Bloop single to shallow center.']
  },
  {
    name: 'E2',
    frame: 'e2-track',
    said: ['Deep fly to right, caught at the warning track.']
  },
  {
    name: 'E3',
    frame: 'e3-wall',
    said: ['Line drive off the wall in left center, double.']
  },
  {
    name: 'E4',
    frame: 'e4-dribbler',
    said: ['Infield dribbler, the pitcher throws him out.']
  },
  {
    name: 'E5',
    frame: 'e5-foul',
    said: [
      'He fouls it off, just shy of first.',
      'Foul ball deep into the right field seats.'
    ]
  },
  { name: 'E6', frame: '', said: ['Fastball, misses high and inside.'] }
]
const FENCE_UNITS = 118
const feet = (point: Point): number =>
  (Math.hypot(point.x, point.z) * 200) / FENCE_UNITS
const radius = (point: Point): number => Math.hypot(point.x, point.z)

/** What each scenario must show, on the branch. */
function check(name: string, report: Report): void {
  const hits = report.timeline.filter(p => p.kind === 'hit')
  const pitches = report.timeline.filter(p => p.kind === 'pitch')
  const hit = hits.at(-1)
  switch (name) {
    case 'E1':
      assert(report.stored.coordinates != null, 'E1 stored no spot')
      // Two depths said: the deeper, shallow, 110 ft at a 200 ft fence.
      assert(
        Math.abs(feet(report.stored.coordinates) - 110) <= 12,
        `E1 bloop at ${feet(report.stored.coordinates)} ft`
      )
      return
    case 'E2':
      assert(hit?.lands != null, 'E2 drew no hit')
      assert(
        radius(hit.lands) >= 109 && radius(hit.lands) <= FENCE_UNITS,
        `E2 caught at ${radius(hit.lands)}`
      )
      return
    case 'E3':
      assert(hit?.lands != null, 'E3 drew no hit')
      assert(radius(hit.lands) > 116, `E3 met the wall at ${radius(hit.lands)}`)
      assert.equal(hit.landingHeight, 3, 'E3 met the wall in the air')
      assert(hit.carom != null, 'E3 has no carom')
      return
    case 'E4':
      assert(hit?.lands != null, 'E4 drew no hit')
      assert(
        Math.abs(radius(hit.lands) - 24) <= 3 && Math.abs(hit.lands.x) < 2,
        `E4 dribbler at ${JSON.stringify(hit.lands)}`
      )
      return
    case 'E5':
      assert.equal(pitches.length, 2, 'E5 two fouls')
      for (const pitch of pitches) {
        assert(pitch.foul != null, 'E5 foul has no spot')
        assert(pitch.foul.x > 0, 'E5 foul on the right')
        assert(Math.abs(pitch.foul.x) > -pitch.foul.z, 'E5 foul is foul')
      }
      assert(
        radius(pitches[1].foul!) > radius(pitches[0].foul!),
        'E5 the deep foul is deeper'
      )
      assert.deepEqual(report.count, { balls: 0, strikes: 2 }, 'E5 count')
      return
    case 'E6': {
      const pitch = report.stored.pitches.at(-1)
      assert.equal(pitch?.type?.code, 'FA', 'E6 fastball')
      assert.deepEqual(
        pitch?.pitchData?.location,
        { height: 'high', side: 'inside', inZone: false },
        'E6 location'
      )
      assert.deepEqual(report.count, { balls: 1, strikes: 0 }, 'E6 count')
    }
  }
}

/** Whether a reply can be scored: a ball in play has its result. */
function scoreable(turn: { kind: string; actions?: ScoringAction[] }): boolean {
  if (turn.kind !== 'actions' || turn.actions == null) return false
  const balls = turn.actions.filter(action => action.type === 'ballInPlay')
  const results = turn.actions.filter(action => action.type === 'result')
  return balls.length <= 1 && (balls.length === 0 || results.length > 0)
}

/**
 * What the real interpreter makes of each sentence, as the integration run
 * asks it: the scoring screen's game at a 200 ft fence, Claude Haiku 5.5,
 * every scoring tool but the lineup's, asked once more when its first reply
 * cannot be scored. Server code, loaded here and not when the spec is.
 */
async function interpret(
  ctx: HarnessContext,
  sentences: readonly string[]
): Promise<Array<{ said: string; actions: ScoringAction[] }>> {
  const { asGameDetail } = await import('../../../../src/common/api')
  const { actionFromTagSlots, promptContext, toolSchema } =
    await import('../../../../src/common/scoring/actions')
  const { rosterPrompt, rosterToolSchema } =
    await import('../../../../src/common/scoring/rosterCommands')
  const { fieldInfoOf } = await import('../../../../src/common/scoring/state')
  const { initialScoringState } =
    await import('../../../../src/app/scoring/scoringMachine')
  const { scoringSession } = await import('../../../../src/test/scoringSession')
  const { Interpretation } =
    await import('../../../../src/server/dictation/interpreter')
  const { endpointFor } =
    await import('../../../../src/server/dictation/models')
  const { asServerConfig } =
    await import('../../../../src/server/serverConfigSchema')
  // The server's own endpoint for the model, with the caller's key.
  const keys = asServerConfig({
    dictation: { apiKey: '', anthropic: { apiKey: ctx.secret('anthropic') } }
  }).dictation!
  const model = 'claude-haiku-5-5'
  const endpoint = endpointFor(model, {
    apiKey: keys.apiKey,
    baseUrl: keys.baseUrl,
    ...(keys.anthropic == null ? {} : { anthropic: keys.anthropic })
  })
  assert(endpoint != null, `the server offers no endpoint for ${model}`)
  // `isUnscoredGame.test.ts`'s game, which the integration run scores.
  const game = asGameDetail({
    nonMemberView: false,
    id: 'g1',
    awayTeamId: 'away',
    homeTeamId: 'home',
    awayTeamName: 'Owls',
    homeTeamName: 'Hawks',
    seasonId: null,
    startAt: null,
    venue: null,
    status: 'scheduled',
    homeScore: null,
    awayScore: null,
    ingestStatus: 'pending',
    ingestMessage: null,
    canScore: true,
    assignedRoles: { away: [], home: ['scorekeeper'] },
    videos: []
  })
  const heard: Array<{ said: string; actions: ScoringAction[] }> = []
  for (const said of sentences) {
    const before = initialScoringState(scoringSession(game), false)
    before.session.gameData.venue = { fieldInfo: fieldInfoOf(200) }
    const ask = async (): Promise<
      Awaited<ReturnType<InstanceType<typeof Interpretation>['start']>>
    > =>
      await new Interpretation(
        {
          apiKey: endpoint.apiKey,
          baseUrl: endpoint.baseUrl,
          model,
          api: endpoint.api,
          tools: toolSchema().filter(tool => tool.name !== 'lineup'),
          rosterTools: rosterToolSchema()
        },
        `${promptContext(before.session)}\nROSTERS\n${rosterPrompt(before.session, ['away', 'home'])}`,
        said
      ).start()
    const first = await ask()
    const turn = scoreable(first) ? first : await ask()
    assert(
      turn.kind === 'actions',
      `the interpreter did not score "${said}": ${JSON.stringify(turn)}`
    )
    // The model names players by tag slot, as the server's route maps them.
    heard.push({
      said,
      actions: turn.actions.map(action =>
        actionFromTagSlots(action, before.session.meta.tagOrder)
      )
    })
  }
  return heard
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export default defineHarness({
  id: 'scoring/dictated-plays/distance',
  title: 'Dictated balls and pitches land where the words put them',
  kind: 'e2e',
  covers: [
    'src/app/scoring/dictatedDepth.ts',
    'src/app/scoring/dictatedGeometry.ts',
    'src/app/scoring/scoringMachine.ts',
    'src/app/scoring/scoringPresentation.ts',
    'src/app/field/BaseballScreen.tsx',
    'src/server/dictation/interpreter.ts',
    'src/test/dictatedDistance.fixture.tsx'
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
  // The interpreter's own model, asked from here as the integration run asks it.
  secrets: ['anthropic'],
  costUsd: 0.05,
  minutes: 10,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'land-where-said': async ctx => {
      const heard = await interpret(
        ctx,
        SCENARIOS.flatMap(scenario => scenario.said)
      )
      writeFileSync(
        ctx.artifact('interpreted.json'),
        JSON.stringify(heard, null, 2)
      )
      const scenarios: Scenario[] = SCENARIOS.map(({ name, said }) => ({
        name,
        said: said.join(' '),
        actions: said.flatMap(sentence => {
          const found = heard.find(entry => entry.said === sentence)
          assert(found != null, `No interpreted actions for "${sentence}"`)
          return found.actions
        })
      }))
      const fixture = await serveFixture(
        ctx,
        'src/test/dictatedDistance.fixture.tsx',
        scenarios
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
          reports = await playEach(
            m,
            fixture,
            scenarios.map(scenario => scenario.name),
            1500
          )
        }
      )
      const zero = recording.startedAtMs
      const lines: string[] = []
      const failures: string[] = []
      for (const { name } of scenarios) {
        const report = reports.get(name)!
        lines.push(
          `${name}: ${JSON.stringify({ stored: report.stored, count: report.count, timeline: report.timeline.map(({ at, end, ...rest }) => rest) })}`
        )
        const frame = SCENARIOS.find(s => s.name === name)!.frame
        // A moment as each ball comes down: the hit, or each of E5's fouls.
        const landings = report.timeline.filter(
          p => p.kind === 'hit' || (p.kind === 'pitch' && name === 'E5')
        )
        for (const [index, landed] of landings.entries()) {
          if (frame === '') break
          const at = landed.at + landed.landsMs
          lines.push(
            `  frame ${frame}${index === 0 ? '' : String(index + 1)}-after at ${Math.round(at - zero)}ms of after-plays.mp4`
          )
        }
        try {
          check(name, report)
          lines.push(`  PASS ${name}`)
        } catch (error) {
          failures.push(`${name}: ${(error as Error).message}`)
          lines.push(`  FAIL ${name}: ${(error as Error).message}`)
        }
      }
      writeFileSync(
        ctx.artifact('dictated-distance.log'),
        lines.join('\n') + '\n'
      )
      assert.deepEqual(failures, [], failures.join('\n'))
    }
  }
})
