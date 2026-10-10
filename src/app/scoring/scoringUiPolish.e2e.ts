import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { recordOf, replayPlays } from '../../common/scoring/gumbo'
import { baseIds } from '../../common/scoring/rules'
import type { GameSetup, GameState } from '../../common/scoring/state'
import { modalFixture } from './scoringModals.e2e.fixture'

const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
const clientRequire = createRequire(
  join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
)
const { MaestroD } = clientRequire('maestro-d')

async function main(): Promise<void> {
  const surface = required('SCORING_MODAL_SURFACE')
  assert(['safari', 'native'].includes(surface))
  const native = surface === 'native'
  const section = process.env.SCORING_UI_SECTION
  assert(
    section == null ||
      ['roster', 'appearance', 'workflow', 'bases', 'tags'].includes(section),
    'SCORING_UI_SECTION must name a supported scenario'
  )
  const phase = 'after'
  const artifacts = resolve(required('SCORING_ARTIFACT_DIR'))
  const daemonName = required('MAESTRO_D')
  const device = required('SCORING_DEVICE_UDID')
  const assetUrl = required('SCORING_ASSET_URL')
  const fixturePort = Number(required('SCORING_FIXTURE_PORT'))
  assert(
    Number.isInteger(fixturePort) && fixturePort > 0 && fixturePort < 65536
  )
  required('SCORING_TEST_URL')
  await mkdir(artifacts, { recursive: true })
  const fixture = await modalFixture(assetUrl, fixturePort)
  const daemon = await MaestroD.connect({
    name: daemonName,
    spawn: false
  }).catch(async (error: unknown) => {
    await fixture.close()
    throw error
  })
  const m = await daemon
    .attach({
      device,
      platform: 'ios',
      appId: native ? 'app.teamstation.app' : 'com.apple.mobilesafari',
      artifacts: 'on-failure',
      waitForIdleTimeout: 500,
      stepDelay: 250
    })
    .catch(async (error: unknown) => {
      try {
        daemon.close()
      } finally {
        await fixture.close()
      }
      throw error
    })
  interface Node {
    text?: string
    type?: string
    enabled?: boolean
    bounds?: { x: number; y: number; width: number; height: number }
    children?: Node[]
  }
  const flat = (node: Node): Node[] => [
    node,
    ...(node.children ?? []).flatMap(flat)
  ]
  const driver = async (): Promise<string> => {
    const log = await readFile(join(daemon.info.runDir, 'daemon.log'), 'utf8')
    const line = log
      .split('\n')
      .filter(value =>
        value.includes(
          `Starting WDA on device ${required('SCORING_DEVICE_UDID')} (port:`
        )
      )
      .at(-1)
    const port = /\(port: (\d+)\)/.exec(line ?? '')?.[1]
    assert(port != null, 'Owned driver endpoint is required')
    const endpoint = `http://127.0.0.1:${port}`
    const status = await m.eval(
      `http.get(${JSON.stringify(endpoint + '/status')})`
    )
    const session = JSON.parse(status.body).sessionId
    assert(typeof session === 'string')
    return endpoint + '/session/' + session
  }
  const point = async (x: number, y: number): Promise<void> => {
    const endpoint = await driver()
    const result = await m.eval(
      `http.post(${JSON.stringify(endpoint + '/wda/tap')}, {body:${JSON.stringify({ x: Math.round(x), y: Math.round(y) })}})`
    )
    assert.equal(result.status, 200)
    assert(JSON.parse(result.body).value?.error == null)
  }
  const tap = async (text: string): Promise<void> => {
    console.log('Tap', text)
    if (native) {
      await m.waitForAnimationToEnd({ timeout: 3000 })
      if (
        ['Ball', 'Called Strike', 'Swing & Miss', 'Foul Ball'].includes(text)
      ) {
        const deadline = Date.now() + 15000
        let ready = false
        while (Date.now() < deadline) {
          ready = flat(await m.hierarchy()).some(
            node =>
              node.text === text &&
              node.type === 'Button' &&
              node.enabled !== false
          )
          if (ready) break
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        assert(ready, `Pitch control ${text} must be enabled before tapping`)
      }
      if (text === 'More') {
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
          const nodes = flat(await m.hierarchy())
          if (nodes.some(node => node.text === 'Dismiss More')) return
          const target = nodes.find(
            node => node.text === text && node.enabled !== false
          )?.bounds
          if (target != null)
            await point(
              target.x + target.width / 2,
              target.y + target.height / 2
            )
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        assert.fail('Native More menu must open after its transition settles')
      }
      if (
        !['Cancel', 'Add Player', 'More'].includes(text) &&
        !text.startsWith('Tag event:')
      ) {
        await m.tapOn({
          id: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          timeout: 15000
        })
        await new Promise(resolve => setTimeout(resolve, 500))
        return
      }
      const deadline = Date.now() + 15000
      let matches: Node[] = []
      do {
        matches = flat(await m.hierarchy()).filter(
          node => node.text === text && node.bounds != null
        )
        if (matches.length !== 0) break
        await new Promise(resolve => setTimeout(resolve, 200))
      } while (Date.now() < deadline)
      const target =
        matches
          .filter(node =>
            ['Button', 'Switch', 'TextField'].includes(node.type ?? '')
          )
          .at(-1) ?? matches.at(-1)
      assert(target?.bounds != null, `Native target ${text} must exist`)
      await point(
        target.bounds.x + target.bounds.width / 2,
        target.bounds.y + target.bounds.height / 2
      )
      await new Promise(resolve => setTimeout(resolve, 500))
      return
    }
    const hierarchy = await m.hierarchy()
    const web = !native
      ? flat(hierarchy).find(node => node.type === 'WebView')
      : undefined
    const nodes = flat(web ?? hierarchy).filter(
      node =>
        (node.text === text ||
          (text.startsWith('Undo ') && node.text?.startsWith(text) === true)) &&
        node.bounds != null
    )
    const node =
      nodes.at(-1) ??
      flat(hierarchy)
        .filter(node => node.text === text && node.bounds != null)
        .at(-1)
    if (node?.bounds == null)
      await m.tapOn({
        text: `^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        timeout: 15000
      })
    else {
      await point(
        node.bounds.x + node.bounds.width / 2,
        node.bounds.y + node.bounds.height / 2
      )
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  const shown = async (text: string): Promise<void> => {
    if (!native) {
      // Read the browser accessibility tree rather than the driver's cached
      // visibility, which can include clipped or underlying modal controls.
      const pattern = new RegExp(text)
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const nodes = flat(await m.hierarchy())
        if (
          nodes.some(node => pattern.test(node.text ?? '')) ||
          pattern.test(nodes.map(node => node.text ?? '').join(' '))
        )
          return
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      assert.fail(`Expected visible browser control: ${text}`)
    }
    await m.assertVisible({
      text: native ? text.replace(/^\^|\$$/g, '') : text,
      timeout: 15000
    })
  }
  const disabledTiebreaker = async (): Promise<void> => {
    await shown('More scoring actions')
    const target = flat(await m.hierarchy()).find(
      node => node.text === 'Place a Runner (Tiebreaker)' && node.bounds != null
    )?.bounds
    assert(target != null, 'Disabled tiebreaker row must remain visible')
    const before = JSON.stringify(fixture.stored())
    // Native disabled rows are text rather than actionable button elements.
    await point(target.x + target.width / 2, target.y + target.height / 2)
    await shown('More scoring actions')
    assert.equal(JSON.stringify(fixture.stored()), before)
    await tap('Dismiss More')
  }
  const dismissDevelopmentWarnings = async (): Promise<void> => {
    if (native) {
      const warning = flat(await m.hierarchy()).find(
        node => node.text?.includes('Open debugger to view warnings.') === true
      )
      if (warning?.bounds != null) {
        await point(
          warning.bounds.x + warning.bounds.width - 22,
          warning.bounds.y + warning.bounds.height / 2
        )
      }
    }
  }
  const capture = async (state: string): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    await dismissDevelopmentWarnings()
    await writeFile(
      join(artifacts, `${surface}-${state}-${phase}.png`),
      await m.screenshot()
    )
    console.log('Captured', state, phase)
  }
  let browserOpened = false
  const open = async (missing = false, existing?: string): Promise<string> => {
    if (native && browserOpened) {
      await m.stopApp()
      await m.launchApp()
    }
    const gameId = existing ?? fixture.reset(missing)
    const link = native
      ? `teamstation://games/${gameId}/score`
      : `${required('SCORING_TEST_URL')}/games/${gameId}/score?capture=${phase}`
    if (!native && browserOpened) {
      await m.tapOn({ id: 'TabBarItemTitle' })
      await m.eraseText()
      await m.inputText({ text: link })
      await m.pressKey('Enter')
    } else if (native) {
      const readyUntil = Date.now() + 45000
      while (Date.now() < readyUntil) {
        const nodes = flat(await m.hierarchy())
        if (
          nodes.some(
            node =>
              node.text === 'Open scoring menu' ||
              node.text?.startsWith('Account,') === true ||
              node.text === 'Sign in to TeamStation'
          )
        )
          break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const endpoint = await driver()
      const result = await m.eval(
        `http.post(${JSON.stringify(endpoint + '/url')},{body:${JSON.stringify({ url: link, bundleId: 'app.teamstation.app', idleTimeoutMs: 1500 })}})`
      )
      assert.equal(result.status, 200)
      assert(JSON.parse(result.body).value?.error == null)
    } else {
      await m.openLink({ link, browser: true })
      await m.tapOn({ id: 'TabBarItemTitle' })
      await m.eraseText()
      await m.inputText({ text: link })
      await m.pressKey('Enter')
    }
    browserOpened = true
    const deadline = Date.now() + 20000
    while (fixture.loaded() !== gameId && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(
      fixture.loaded(),
      gameId,
      'Navigation must load the newly reset game'
    )
    await new Promise(resolve => setTimeout(resolve, 1500))
    await shown('^Open scoring menu$')
    await shown(missing ? 'Missing defensive positions' : '^Ball$')
    await dismissDevelopmentWarnings()
    console.log('Opened synthetic scoring fixture')
    return gameId
  }
  const menu = async (label: string): Promise<void> => {
    await tap('Open scoring menu')
    await tap(label)
  }
  const reach = async (text: string): Promise<void> => {
    if (!native) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const nodes = flat(await m.hierarchy())
        const screen = nodes.find(node => node.type === 'Window')?.bounds
        assert(screen != null)
        const target = nodes.filter(node => node.text === text).at(-1)?.bounds
        if (
          target != null &&
          target.y >= 80 &&
          target.y + target.height <=
            screen.height - (text === 'Done' ? 100 : 110)
        )
          return
        const endpoint = await driver()
        const result = await m.eval(
          `http.post(${JSON.stringify(endpoint + '/wda/dragfromtoforduration')}, {body:${JSON.stringify({ fromX: Math.round(screen.width * 0.65), fromY: Math.round(screen.height - 200), toX: Math.round(screen.width * 0.65), toY: 280, duration: 0.001 })}})`
        )
        assert.equal(result.status, 200)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      assert.fail(`Browser action must remain reachable: ${text}`)
    }
    await m.scrollUntilVisible({
      element: { text: `^${text}$` },
      direction: 'DOWN',
      timeout: 15000
    })
  }
  const input = async (label: string, value: string): Promise<void> => {
    const nodes = flat(await m.hierarchy())
    const target = nodes
      .filter(node => node.text === label && node.type === 'TextField')
      .at(-1)
    assert(target?.bounds != null, `Input ${label} must be present`)
    await point(
      target.bounds.x + target.bounds.width / 2,
      target.bounds.y + target.bounds.height / 2
    )
    await m.eraseText()
    await m.inputText({ text: value })
  }
  const finishKeyboard = async (): Promise<void> => {
    if (native) {
      for (let i = 0; i < 3; i++) {
        if (!flat(await m.hierarchy()).some(node => node.type === 'Keyboard'))
          break
        await m.pressKey('Enter')
      }
    } else await tap('Done')
  }
  let setup: GameSetup | undefined
  const snapshot = (): GameState | undefined => {
    const stored = fixture.stored()
    setup ??= recordOf(stored.currentPlay ?? stored.plays[0])?.setupBefore
    if (setup == null) return undefined
    const result = replayPlays(stored, {
      gamePk: fixture.loaded(),
      teams: {
        away: { id: 'away', name: 'Owls' },
        home: { id: 'home', name: 'Hawks' }
      },
      setup
    })
    assert.deepEqual(result.problems, [])
    return result.state
  }
  const saved = async (check: (state: GameState) => boolean): Promise<void> => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const state = snapshot()
      if (state != null && check(state)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const state = snapshot()
    assert.fail(
      'Expected persisted scoring state: ' +
        JSON.stringify({
          inning: state?.liveData.linescore.currentInning,
          top: state?.liveData.linescore.isTopInning,
          balls: state?.liveData.linescore.balls,
          strikes: state?.liveData.linescore.strikes,
          outs: state?.liveData.linescore.outs,
          completedPlays: state?.liveData.plays.allPlays.filter(
            play => play.about.isComplete
          ).length
        })
    )
  }
  const undo = async (): Promise<void> => {
    const label = flat(await m.hierarchy()).find(
      node => node.text?.startsWith('Undo ') === true
    )?.text
    assert(label != null, 'Undo must be available')
    await tap(label)
  }
  const rosterInteractions = async (): Promise<void> => {
    await open()
    await menu('Set Team Rosters')
    const order = async (): Promise<string[]> => [
      ...new Set(
        flat(await m.hierarchy())
          .filter(node => node.text?.startsWith('Reorder ') === true)
          .map(node => node.text!)
      )
    ]
    assert.deepEqual((await order()).slice(0, 2), [
      'Reorder Mookie Betts',
      'Reorder Mike Trout'
    ])
    const nodes = flat(await m.hierarchy())
    const from = nodes.find(node => node.text === 'Drag Mike Trout')?.bounds
    const to = nodes.find(node => node.text === 'Reorder Mookie Betts')?.bounds
    assert(from != null && to != null)
    await m.dragAndDrop({
      from: {
        point: `${Math.round(from.x + from.width / 2)},${Math.round(from.y + from.height / 2)}`
      },
      to: {
        point: `${Math.round(to.x + to.width / 2)},${Math.round(to.y + 6)}`
      },
      holdDuration: 700,
      duration: 1000
    })
    assert.deepEqual((await order()).slice(0, 2), [
      'Reorder Mike Trout',
      'Reorder Mookie Betts'
    ])
    await tap('Remove Mike Trout')
    await shown('Add Mike Trout to Lineup')
    await tap('Add Mike Trout to Lineup')
    assert.equal((await order()).at(-1), 'Reorder Mike Trout')
    await tap('Cancel')
    await menu('Set Team Rosters')
    assert.deepEqual((await order()).slice(0, 2), [
      'Reorder Mookie Betts',
      'Reorder Mike Trout'
    ])
    await tap('Cancel')
    console.log(
      'PASS actual roster hold/drag, remove, tap-to-add and draft cancellation'
    )
  }
  const appearance = async (): Promise<void> => {
    await open()
    await menu('Set Team Rosters')
    await shown('Roster')
    await capture('roster')
    await tap('Set Defense')
    await capture('roster-defense')
    await tap('Set Lineup')
    await tap('Create Player')
    await finishKeyboard()
    await capture('player')
    for (const position of [
      'LF',
      'CF',
      'RF',
      '3B',
      'SS',
      '2B',
      '1B',
      'P',
      'C',
      'DH',
      'EH'
    ])
      await tap('Player position ' + position)
    await reach('Add Placeholder Players')
    await tap('Add Placeholder Players')
    await shown('Select number of players to add')
    await capture('placeholder')
    await tap('Cancel')
    await input('First Name', 'Jose')
    await m.pressKey('Enter')
    await input('Last Name', 'Ramirez')
    await m.pressKey('Enter')
    await input('Jersey Number', '11')
    await finishKeyboard()
    await reach('Add Player')
    await tap('Add Player')
    await shown('Jose Ramirez')
    await tap('Create Player')
    await finishKeyboard()
    await reach('Add Placeholder Players')
    await tap('Add Placeholder Players')
    await shown('Select number of players to add')
    await tap('Add')
    await tap('Cancel')
    await shown('Save Rosters')
    await tap('Cancel')
    for (const [label, key] of [
      ['End Half Inning', 'half'],
      ['End Game', 'game']
    ]) {
      await menu(label)
      await capture(key)
      await tap('Cancel')
    }
    await menu('Settings')
    await shown('Scoring sound')
    await capture('settings')
    for (const label of [
      'Toggle scoring sound',
      'Toggle play animations',
      'Toggle switch-hitter help'
    ]) {
      await tap(label)
      await tap(label)
    }
    await reach('Done')
    await tap('Done')
    await menu('Overrides')
    await reach('Batter')
    await tap('Batter')
    await capture('overrides-choice')
    await tap('Cancel')
    await open(true)
    await tap('Assign P')
    await shown('Assign pitcher')
    await capture('defensive')
    await tap('Cancel')
    console.log(
      'PASS portrait scoring appearance, all position toggles, settings toggles and modal cancellation'
    )
  }
  const workflow = async (): Promise<void> => {
    setup = undefined
    const game = await open()
    await tap('More')
    await tap('Place a Runner (Tiebreaker)')
    await shown('Place runner on base')
    await capture('tiebreaker')
    await tap('Place runner on base')
    await shown('Place runner on 2B')
    await capture('bases')
    const bases = flat(await m.hierarchy()).filter(node =>
      /^Place runner on [123]B$/.test(node.text ?? '')
    )
    assert.equal(new Set(bases.map(node => node.text)).size, 3)
    if (section === 'bases') {
      await tap('Cancel runner placement')
      await shown('Juan Soto')
      console.log('PASS base targets and restoration after cancel')
      return
    }
    await tap('Place runner on 2B')
    await shown('Select Runner for 2B')
    await shown('Recently Batted Players')
    await capture('runner')
    const labels = flat(await m.hierarchy())
      .filter(node => node.text?.startsWith('Select runner #') === true)
      .map(node => node.text)
    assert.deepEqual(
      [...new Set(labels)],
      [
        'Select runner #9 Bobby Witt',
        'Select runner #8 Juan Soto',
        'Select runner #7 Francisco Lindor',
        'Select runner #6 Freddie Freeman',
        'Select runner #5 Bryce Harper',
        'Select runner #4 Aaron Judge',
        'Select runner #3 Shohei Ohtani',
        'Select runner #2 Mike Trout'
      ]
    )
    await tap('Select runner #9 Bobby Witt')
    await shown('Place runner on base')
    await saved(state => baseIds(state).filter(id => id != null).length === 1)
    const first = baseIds(snapshot()!)[1]
    assert(first != null)
    const unchanged = snapshot()!
    await tap('Set Outs 1')
    await saved(state => state.liveData.linescore.outs === 1)
    const beforeActions = recordOf(fixture.stored().currentPlay)!.actions.length
    const nodes = flat(await m.hierarchy())
    const from = nodes.filter(node => node.text === 'Set Outs 1').at(-1)?.bounds
    const to = nodes.filter(node => node.text === 'Set Outs 2').at(-1)?.bounds
    assert(from != null && to != null)
    await m.dragAndDrop({
      from: {
        point: `${Math.round(from.x + from.width / 2)},${Math.round(from.y + from.height / 2)}`
      },
      to: {
        point: `${Math.round(to.x + to.width / 2)},${Math.round(to.y + to.height / 2)}`
      },
      holdDuration: 100,
      duration: 800
    })
    await saved(state => state.liveData.linescore.outs === 2)
    assert.equal(
      recordOf(fixture.stored().currentPlay)!.actions.length,
      beforeActions + 1,
      'Outs drag commits once'
    )
    assert.deepEqual(snapshot()!.liveData.boxscore, unchanged.liveData.boxscore)
    assert.deepEqual(baseIds(snapshot()!), [null, first, null])
    await tap('Place runner on base')
    await tap('Place runner on 2B')
    await shown('Cancel runner placement')
    await tap('Place runner on 3B')
    await shown('Select Runner for 3B')
    await tap('Cancel')
    await shown('Place runner on 1B')
    await tap('Place runner on 3B')
    await tap('Select runner #8 Juan Soto')
    await shown('Place runner on base')
    await tap('Cancel')
    await saved(state => baseIds(state).filter(id => id != null).length === 2)
    const second = baseIds(snapshot()!)[2]
    assert(second != null)
    const persisted = JSON.stringify(fixture.stored())
    await open(false, game)
    await tap('More')
    await tap('Place a Runner (Tiebreaker)')
    await shown('Set Outs 2')
    await tap('Cancel')
    assert.equal(
      JSON.stringify(fixture.stored()),
      persisted,
      'Reopening must preserve saved setup'
    )
    for (const [outs, expected] of [
      [2, [null, first, null]],
      [1, [null, first, null]],
      [0, [null, first, null]],
      [0, [null, null, null]]
    ] as const) {
      await undo()
      await saved(
        state =>
          state.liveData.linescore.outs === outs &&
          JSON.stringify(baseIds(state)) === JSON.stringify(expected)
      )
    }
    await tap('Ball')
    await saved(state => state.liveData.linescore.balls === 1)
    await tap('More')
    await disabledTiebreaker()
    await undo()
    await saved(state => state.liveData.linescore.balls === 0)
    await tap('More')
    await tap('Place a Runner (Tiebreaker)')
    await shown('Place runner on base')
    await tap('Cancel')
    for (let strike = 1; strike <= 3; strike++) {
      await tap('Called Strike')
      await saved(state =>
        strike < 3
          ? state.liveData.linescore.strikes === strike
          : state.liveData.plays.allPlays.some(play => play.about.isComplete)
      )
    }
    await menu('End Half Inning')
    await tap('Confirm End Half Inning')
    await saved(state => !state.liveData.linescore.isTopInning)
    // Reload saved halves on native: the baseline simulator software GL
    // renderer stalls while draining the live half-transition draw queue.
    if (native) await open(false, game)
    await tap('More')
    await disabledTiebreaker()
    await menu('End Half Inning')
    await tap('Confirm End Half Inning')
    await saved(
      state =>
        state.liveData.linescore.isTopInning &&
        state.liveData.linescore.currentInning === 2
    )
    if (native) await open(false, game)
    await tap('More')
    await tap('Place a Runner (Tiebreaker)')
    await shown('Place runner on base')
    await tap('Place runner on base')
    await tap('Place runner on 1B')
    await shown('Select Runner for 1B')
    const recent = [
      ...new Set(
        flat(await m.hierarchy())
          .filter(node => node.text?.startsWith('Select runner #') === true)
          .map(node => node.text)
      )
    ]
    assert.equal(recent[0], 'Select runner #1 Mookie Betts')
    assert(!recent.includes('Select runner #2 Mike Trout'))
    await tap('Cancel')
    await tap('Cancel runner placement')
    console.log(
      'PASS persisted runners, one-action outs drag, each Undo step, first-pitch/bottom gating, next top, occupied base and cancellation'
    )
  }
  const tagsAndExit = async (): Promise<void> => {
    await open()
    fixture.pauseWrites(true)
    await tap('Ball')
    await shown('Undo Ball')
    const target = flat(await m.hierarchy())
      .filter(node => node.text?.startsWith('Undo Ball') === true)
      .at(-1)?.bounds
    assert(target != null)
    const endpoint = await driver()
    const result = await m.eval(
      `http.post(${JSON.stringify(endpoint + '/wda/touchAndHold')},{body:${JSON.stringify({ x: Math.round(target.x + target.width / 2), y: Math.round(target.y + target.height / 2), duration: native ? 2.2 : 0.65 })}})`
    )
    assert.equal(result.status, 200)
    await shown('Tap event to assign a tag')
    await tap('Tag event: Ball')
    await shown('New tag')
    await capture('tag-editor')
    await tap('Cancel')
    await menu('Exit Current Game')
    await shown('Discard and Exit')
    await capture('exit')
    await tap('Cancel')
    fixture.pauseWrites(false)
    console.log(
      'PASS short Undo and long hold tag editor plus dirty-exit cancellation'
    )
  }
  try {
    await m.stopApp()
    await m.launchApp({ stopApp: true })
    if (section == null || section === 'roster') await rosterInteractions()
    if (section == null || section === 'appearance') await appearance()
    if (section == null || ['workflow', 'bases'].includes(section))
      await workflow()
    if (section == null || ['appearance', 'tags'].includes(section))
      await tagsAndExit()
    console.log(`PASS ${surface} scoring UI polish`)
  } finally {
    fixture.pauseWrites(false)
    try {
      await m.detach()
    } finally {
      try {
        daemon.close()
      } finally {
        await fixture.close()
      }
    }
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
