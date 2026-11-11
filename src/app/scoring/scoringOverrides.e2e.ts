/**
 * Run with node -r sucrase/register and the SCORING_* fixture environment
 * used by scoringModals.e2e.ts. MAESTRO_D names this run's private daemon.
 */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { recordOf, replayPlays } from '../../common/scoring/gumbo'
import { baseIds } from '../../common/scoring/rules'
import type { GameSetup, GameState } from '../../common/scoring/state'
import { modalFixture } from './scoringModals.e2e.fixture'

const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
interface Node {
  type?: string
  enabled?: boolean
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
const flat = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flat)
]
async function main(): Promise<void> {
  const { MaestroD } = createRequire(
    join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
  )('maestro-d')
  const fixture = await modalFixture(
    required('SCORING_ASSET_URL'),
    Number(required('SCORING_FIXTURE_PORT'))
  )
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  const m = await daemon.attach({
    device: required('SCORING_DEVICE_UDID'),
    platform: 'ios',
    appId: 'com.apple.mobilesafari',
    artifacts: 'on-failure',
    waitForIdleTimeout: 500,
    stepDelay: 250
  })
  const pause = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  const tap = async (text: string): Promise<void> => {
    console.log('Tap', text)
    await m.waitForAnimationToEnd({ timeout: 3000 })
    const hierarchy = await m.hierarchy()
    const nodes = flat(
      flat(hierarchy).find(node => node.type === 'WebView') ?? hierarchy
    )
    const node = nodes
      .filter(node => node.text === text && node.bounds != null)
      .at(-1)
    if (node?.bounds != null) {
      const b = node.bounds
      await m.tapOn({
        point: `${Math.round(b.x + b.width / 2)},${Math.round(b.y + b.height / 2)}`
      })
    } else
      await m.tapOn({
        text: `^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        timeout: 15000
      })
    await pause()
  }
  const capture = async (name: string): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    await writeFile(
      join(required('SCORING_ARTIFACT_DIR'), `${name}-after.png`),
      await m.screenshot()
    )
  }
  const menu = async (): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    await tap('Open scoring menu')
    await tap('Overrides')
  }
  let setup: GameSetup | undefined
  const snapshot = (): GameState | undefined => {
    const stored = fixture.stored()
    setup ??= recordOf(stored.currentPlay ?? stored.plays[0], {
      away: { id: 'away' },
      home: { id: 'home' }
    })?.setupBefore
    if (setup == null) return undefined
    const replay = replayPlays(stored, {
      gamePk: fixture.loaded(),
      teams: {
        away: { id: 'away', name: 'Owls' },
        home: { id: 'home', name: 'Hawks' }
      },
      setup
    })
    assert.deepEqual(replay.problems, [])
    return replay.state
  }
  const saved = async (
    check: (state: GameState) => boolean
  ): Promise<GameState> => {
    for (let i = 0; i < 40; i++) {
      const state = snapshot()
      if (state != null && check(state)) return state
      await pause()
    }
    assert.fail(
      'Persisted state did not match: ' +
        JSON.stringify(snapshot()?.liveData.linescore)
    )
  }
  try {
    const id = fixture.reset()
    await m.openLink({
      link: `${required('SCORING_TEST_URL')}/games/${id}/score`,
      browser: true
    })
    await m.assertVisible({ text: 'Open scoring menu', timeout: 45000 })
    await menu()
    await tap('Batter')
    await tap('3. Shohei Ohtani #3')
    await tap('Batter')
    await m.scrollUntilVisible({
      element: { text: '^Julio Rodriguez #10$' },
      direction: 'DOWN',
      timeout: 15000
    })
    await tap('Julio Rodriguez #10')
    await tap('Apply Override')
    const openingPinch = await saved(
      state => state.liveData.linescore.offense.batter?.id === 109
    )
    assert.equal(openingPinch.liveData.boxscore.teams.away.battingIndex, 2)
    assert.equal(openingPinch.liveData.boxscore.teams.away.battingOrder[2], 109)
    await tap('Undo Override game state')
    await saved(state => state.liveData.linescore.offense.batter?.id === 100)
    await tap('Ball')
    const before = await saved(state => state.liveData.linescore.balls === 1)
    const pitcher = before.liveData.linescore.defense.P?.id
    await menu()
    await capture('overrides')
    await tap('Inning')
    await capture('inning')
    const wheel = flat(await m.hierarchy()).find(
      node => node.text === 'Inning: 1'
    )?.bounds
    assert(wheel != null)
    await m.tapOn({
      point: `${Math.round(wheel.x + wheel.width / 2)},${Math.round(wheel.y + wheel.height / 2 + 44)}`
    })
    await pause()
    await tap('Done')
    await tap('Owls score')
    const scoreWheel = flat(await m.hierarchy()).find(
      node => node.text === 'Owls: 0'
    )?.bounds
    assert(scoreWheel != null)
    await m.tapOn({
      point: `${Math.round(scoreWheel.x + scoreWheel.width / 2)},${Math.round(scoreWheel.y + scoreWheel.height / 2 + 44)}`
    })
    await pause()
    await capture('score')
    await tap('Done')
    await tap('Balls 3')
    await tap('Strikes 2')
    await tap('Outs 1')
    await tap('Apply Override')
    const numeric = await saved(
      state =>
        state.liveData.linescore.currentInning === 2 &&
        state.liveData.linescore.teams.away.runs === 1
    )
    assert.equal(numeric.liveData.linescore.balls, 3)
    assert.equal(numeric.liveData.linescore.strikes, 2)
    assert.equal(numeric.liveData.linescore.outs, 1)
    assert.equal(numeric.liveData.linescore.defense.P?.id, pitcher)
    await tap('Undo Override game state')
    await saved(
      state =>
        state.liveData.linescore.currentInning === 1 &&
        state.liveData.linescore.teams.away.runs === 0
    )
    await tap('Undo Ball')
    await saved(state => state.liveData.linescore.balls === 0)
    await tap('More')
    await tap('Place a Runner (Tiebreaker)')
    await tap('Place runner on base')
    await tap('Place runner on 1B')
    await tap('Select runner #2 Mike Trout')
    await tap('Cancel')
    const occupied = await saved(state => baseIds(state)[0] === 101)
    await menu()
    await tap('Batter')
    await capture('batter')
    assert.equal(
      flat(await m.hierarchy()).find(node => node.text === '2. Mike Trout #2')
        ?.enabled,
      false
    )
    await tap('3. Shohei Ohtani #3')
    await tap('Apply Override')
    const skipped = await saved(
      state => state.liveData.linescore.offense.batter?.id === 102
    )
    assert.deepEqual(baseIds(skipped), baseIds(occupied))
    assert.equal(skipped.liveData.linescore.defense.P?.id, pitcher)
    await menu()
    await tap('Batter')
    await m.scrollUntilVisible({
      element: { text: '^Julio Rodriguez #10$' },
      direction: 'DOWN',
      timeout: 15000
    })
    await tap('Julio Rodriguez #10')
    await tap('Apply Override')
    const pinched = await saved(
      state => state.liveData.linescore.offense.batter?.id === 109
    )
    assert.equal(pinched.liveData.boxscore.teams.away.battingOrder[2], 109)
    assert(!pinched.liveData.boxscore.teams.away.battingOrder.includes(102))
    assert.deepEqual(baseIds(pinched), baseIds(occupied))
    await tap('Undo Override game state')
    await saved(state => state.liveData.linescore.offense.batter?.id === 102)
    await menu()
    await tap('Bottom')
    await tap('Apply Override')
    const half = await saved(state => !state.liveData.linescore.isTopInning)
    assert.equal(half.liveData.linescore.defense.P, null)
    assert.deepEqual(baseIds(half), [null, null, null])
    await m.assertVisible({ text: 'Assign a pitcher', timeout: 10000 })
    await capture('half-reset')
    await tap('Assign P')
    await tap('Assign P #1 Mookie Betts')
    const repaired = await saved(
      state => state.liveData.linescore.defense.P?.id === 100
    )
    assert.equal(repaired.liveData.linescore.offense.batter?.id, 200)
    await m.openLink({
      link: `${required('SCORING_TEST_URL')}/games/${id}/score?reopen=${Date.now()}`,
      browser: true
    })
    await m.assertVisible({ text: 'Open scoring menu', timeout: 45000 })
    await menu()
    // Swipe through the blank middle of the rows: Safari reports text under
    // the floating footer as visible, so scrollUntilVisible alone can stop early.
    await m.swipe({ start: '50%,65%', end: '50%,35%', duration: 200 })
    await m.waitForAnimationToEnd({ timeout: 3000 })
    const scrolled = flat(await m.hierarchy())
    const lastRow = scrolled
      .filter(node => node.text === 'Third base')
      .at(-1)?.bounds
    const apply = scrolled
      .filter(node => node.text === 'Apply Override')
      .at(-1)?.bounds
    assert(lastRow != null && apply != null)
    assert(lastRow.y + lastRow.height < apply.y, 'Third base must clear Apply')
    await capture('inline-runners')
    await tap('Second base')
    await capture('runner-correction')
    await tap('Choose Second base Mike Trout #2')
    await tap('Apply Override')
    const corrected = await saved(state => baseIds(state)[1] === 201)
    assert.equal(
      corrected.liveData.linescore.offense.reachedOnError?.second,
      false
    )
    assert(
      !corrected.liveData.plays.currentPlay!.playEvents.some(
        event => event.details.code === 'placed_runner'
      )
    )
    await menu()
    await tap('Top')
    await tap('Apply Override')
    const back = await saved(state => state.liveData.linescore.isTopInning)
    assert.equal(back.liveData.linescore.defense.P, null)
    assert.deepEqual(baseIds(back), [null, null, null])
    await tap('Assign P')
    await tap('Assign P #1 Mookie Betts')
    const topRepaired = await saved(
      state => state.liveData.linescore.defense.P?.id === 200
    )
    assert.equal(
      topRepaired.liveData.linescore.offense.batter?.id,
      back.liveData.linescore.offense.batter?.id
    )
    assert.equal(
      topRepaired.liveData.boxscore.teams.away.battingIndex,
      back.liveData.boxscore.teams.away.battingIndex
    )
    await tap('Undo Set team roster')
    await saved(state => state.liveData.linescore.defense.P == null)
    await tap('Undo Override game state')
    await saved(
      state =>
        !state.liveData.linescore.isTopInning && baseIds(state)[1] === 201
    )
    await tap('Ball')
    await saved(state => state.liveData.linescore.balls === 1)
    console.log(
      'PASS override card, numeric dialogs, skip, pinch hit, persistence, Undo and correct-side half reset/repair'
    )
  } finally {
    await fixture.close()
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
