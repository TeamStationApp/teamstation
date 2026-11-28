import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import type { Browser } from 'puppeteer'
import { PerspectiveCamera, Vector3 } from 'three'

import { modalFixture } from '../../../e2e/fixtures/scoringModalsFixture'
import { emptyPitcherTarget } from '../../../e2e/rigs/emptyPitcherTarget'
import {
  installSceneProbe,
  maestroDriver,
  setTrajectory,
  tapFielder
} from '../../../e2e/rigs/fieldPointer'
import { turnWheel, wheelAt, wheelValue } from '../../../e2e/rigs/iosWheel'
import { browserSession } from '../../../e2e/rigs/refinementsMaestro'
import { recordOf } from '../../common/scoring/gumbo'
import type { StoredGame } from '../../common/scoring/session'
import { applyFieldCamera } from '../field/cameraModel'
import { BASES, createPlayers } from '../field/fieldModel'
import { runnerTargets } from './runnerDrag'

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
  const chromium = surface === 'chromium'
  assert(['safari', 'native', 'chromium'].includes(surface))
  if (chromium) assert.equal(process.env.SCORING_MODAL_SECTION, 'endGame')
  const native = surface === 'native'
  const nativeAppId = process.env.SCORING_APP_ID ?? 'app.teamstation.app'
  const baseline = process.env.SCORING_MODAL_BASELINE === '1'
  const phase = baseline ? 'before' : 'after'
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
    ...(chromium ? { bin: required('MAESTRO_D_BIN') } : { spawn: false })
  }).catch(async (error: unknown) => {
    await fixture.close()
    throw error
  })
  let browser: Browser | undefined
  const m = await (async () => {
    if (chromium) {
      const session = await browserSession(daemon, device, 430, 932, artifacts)
      browser = session.browser
      await installSceneProbe(session.page)
      return session.m
    }
    return await daemon.attach({
      device,
      platform: 'ios',
      appId: native ? nativeAppId : 'com.apple.mobilesafari',
      artifacts: 'on-failure',
      waitForIdleTimeout: 500,
      stepDelay: 250
    })
  })().catch(async (error: unknown) => {
    daemon.close()
    await fixture.close()
    throw error
  })
  interface Node {
    text?: string
    type?: string
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
    if (!native && !chromium && text === 'Assign P') {
      const window = flat(await m.hierarchy()).find(
        node => node.type === 'Window'
      )?.bounds
      assert(window != null)
      const { x, y } = emptyPitcherTarget(await m.screenshot(), window.width)
      await m.tapOn({ point: `${Math.round(x)},${Math.round(y)}` })
      return
    }
    if (chromium) {
      await m.tapOn({
        css: `[aria-label="${text}"]:not([aria-disabled="true"])`,
        timeout: 15000
      })
      return
    }
    if (native) {
      const id = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const defensivePlayer = text.startsWith('Assign P #')
      const label = { text: `^${id}$`, timeout: 15000 }
      if (!defensivePlayer) await m.assertVisible(label)
      if (text !== 'Create Player' && text !== 'Cancel' && !defensivePlayer) {
        await m.tapOn(label)
        await new Promise(resolve => setTimeout(resolve, 500))
        return
      }
      await m.waitForAnimationToEnd({ timeout: 3000 })
      const matches = flat(await m.hierarchy()).filter(
        node => node.text === text
      )
      const target =
        matches
          .filter(
            node =>
              node.type === 'Button' ||
              node.type === 'Switch' ||
              node.type === 'TextField'
          )
          .at(-1) ?? matches.at(-1)
      assert(target?.bounds != null, `Native target ${text} must exist`)
      await m.tapOn({
        point: `${Math.round(target.bounds.x + target.bounds.width / 2)},${Math.round(target.bounds.y + target.bounds.height / 2)}`
      })
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
    const segment = ['Roster', 'Lineup', 'Defense'].includes(text)
      ? nodes.find(node => node.type !== 'StaticText')
      : undefined
    const node =
      segment ??
      nodes
        .filter(
          node =>
            node.type === 'Button' ||
            node.type === 'Switch' ||
            node.type === 'TextField'
        )
        .at(-1) ??
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
    if (chromium) {
      await m.assertVisible({ text, timeout: 20000 })
      return
    }
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
  const capture = async (state: string): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
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
    await writeFile(
      join(artifacts, `${surface}-${state}-${phase}.png`),
      await m.screenshot()
    )
    await writeFile(
      join(artifacts, `${surface}-${state}-${phase}.json`),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
    console.log('Captured', state, phase)
  }
  let browserOpened = false
  const open = async (
    missing = false,
    existingGame?: string
  ): Promise<void> => {
    if (native) {
      await m.stopApp()
      await m.launchApp()
    }
    const gameId = existingGame ?? fixture.reset(missing)
    const link = native
      ? `teamstation://games/${gameId}/score`
      : `${required('SCORING_TEST_URL')}/games/${gameId}/score?capture=${phase}`
    if (!native && !chromium && browserOpened) {
      const endpoint = await driver()
      const result = await m.eval(
        `http.post(${JSON.stringify(endpoint + '/url')},{body:${JSON.stringify({ url: link, bundleId: 'com.apple.mobilesafari', idleTimeoutMs: 1500 })}})`
      )
      assert.equal(result.status, 200)
      assert(JSON.parse(result.body).value?.error == null)
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
        `http.post(${JSON.stringify(endpoint + '/url')},{body:${JSON.stringify({ url: link, bundleId: nativeAppId, idleTimeoutMs: 1500 })}})`
      )
      assert.equal(result.status, 200)
      assert(JSON.parse(result.body).value?.error == null)
    } else await m.openLink({ link, browser: true })
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
    if (existingGame == null)
      await shown(missing ? 'Assign a pitcher' : '^Ball$')
    console.log('Opened synthetic game', gameId)
  }
  const menu = async (label: string): Promise<void> => {
    await tap('Open scoring menu')
    await tap(label)
  }
  const reach = async (text: string): Promise<void> => {
    if (text.startsWith('Add Owls ')) {
      // The roster has separate columns; swipe inside the player column.
      for (let attempt = 0; attempt < 10; attempt++) {
        const nodes = flat(await m.hierarchy())
        const screen = nodes.find(node => node.type === 'Window')?.bounds
        assert(screen != null)
        const target = nodes
          .filter(
            node =>
              node.text === text || node.text?.startsWith(text + ',') === true
          )
          .at(-1)?.bounds
        if (
          target != null &&
          target.height > 0 &&
          target.y > 200 &&
          target.y + target.height < screen.height - 180
        )
          return
        const endpoint = await driver()
        const x = Math.round(screen.width / 4)
        const result = await m.eval(
          `http.post(${JSON.stringify(endpoint + '/wda/dragfromtoforduration')}, {body:${JSON.stringify({ fromX: x, fromY: Math.round(screen.height - 220), toX: x, toY: 300, duration: 0.001 })}})`
        )
        assert.equal(result.status, 200)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      assert.fail(`Roster player must be reachable: ${text}`)
    }
    if (!native) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const nodes = flat(await m.hierarchy())
        const screen = nodes.find(node => node.type === 'Window')?.bounds
        assert(screen != null)
        const target = nodes
          .filter(
            node =>
              node.text === text || node.text?.startsWith(text + ',') === true
          )
          .at(-1)?.bounds
        const rosterFooter = nodes.find(
          node => node.text === 'Save Rosters'
        )?.bounds
        const form = nodes.some(node => node.text === 'First Name')
        const limit =
          rosterFooter != null && !form
            ? rosterFooter.y - 6
            : screen.height - (text === 'Done' ? 100 : 110)
        if (
          target != null &&
          target.y >= 80 &&
          target.y + target.height <= limit
        )
          return
        const endpoint = await driver()
        const x = Math.round(screen.width * 0.65)
        const high = 270
        const low = Math.round(Math.min(screen.height - 200, limit - 45))
        const above = target != null && target.y < 80
        const result = await m.eval(
          `http.post(${JSON.stringify(endpoint + '/wda/dragfromtoforduration')}, {body:${JSON.stringify({ fromX: x, fromY: above ? high : low, toX: x, toY: above ? low : high, duration: 0.001 })}})`
        )
        assert.equal(result.status, 200)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      assert.fail(`Browser action must remain reachable: ${text}`)
    }
    await m.scrollUntilVisible({
      element: { text: `^${text}(,.*)?$` },
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
    } else if (flat(await m.hierarchy()).some(node => node.type === 'Keyboard'))
      await tap('Done')
  }
  const exitConfirmation = async (): Promise<void> => {
    fixture.refuseWrites(true)
    await tap('Ball')
    await shown('Fixture scoring edit refused')
    await menu('Exit Current Game')
    await shown('Discard and Exit')
    await capture('exit')
    await tap('Cancel')
    fixture.refuseWrites(false)
  }
  const behavior = async (): Promise<void> => {
    await open()
    await menu('Settings')
    for (const label of [
      'Toggle scoring sound',
      'Toggle play animations',
      'Toggle switch-hitter help'
    ]) {
      await tap(label)
      await tap(label)
    }
    await tap('Reset shown count')
    await shown('Switch-hitter help shown 0 of 3 times')
    await reach('Done')
    await tap('Done')
    await menu('Settings')
    await shown('Switch-hitter help shown 0 of 3 times')
    await reach('Done')
    await tap('Done')
    await tap('Ball')
    await shown('Undo Ball')
    await tap('Undo Ball')
    await menu('Set Team Rosters')
    await tap('Home Team')
    await tap('Away Team')
    await tap('Defense')
    await tap('Lineup')
    await tap('Roster')
    await reach('Create Player')
    await tap('Create Player')
    await shown('^First Name$')
    await input('First Name', 'Jose')
    await m.pressKey('Enter')
    await input('Last Name', 'Ramirez')
    await m.pressKey('Enter')
    await input('Jersey Number', '11')
    await finishKeyboard()
    for (const label of [
      'Player position P',
      'Player position SS',
      'Throws L',
      'Bats S'
    ])
      await tap(label)
    await reach('Save and Create Another Player')
    await tap('Save and Create Another Player')
    await shown('First Name')
    await input('First Name', 'Gerrit')
    await m.pressKey('Enter')
    await input('Last Name', 'Cole')
    await m.pressKey('Enter')
    await input('Jersey Number', '12')
    await finishKeyboard()
    await reach('Create Player')
    await tap('Create Player')
    await reach('Gerrit Cole')
    await shown(
      'Gerrit Cole, jersey 12, bats right, throws right, edit settings'
    )
    await reach('Jose Ramirez')
    await shown(
      'Jose Ramirez, jersey 11, bats switch, throws left, positions P, SS, edit settings'
    )
    await tap('Save Rosters')
    await shown('Undo Set team roster')
    // Undo removes the scorer’s confirmation. Reading team membership can
    // add the new accounts back to the game as an unconfirmed roster action.
    const savedRoster = (book: StoredGame): boolean =>
      [
        ...book.plays,
        ...(book.currentPlay == null ? [] : [book.currentPlay])
      ].some(
        play =>
          recordOf(play, {
            away: { id: 'away' },
            home: { id: 'home' }
          })?.actions.some(
            action =>
              action.type === 'lineup' &&
              action.kind === 'roster' &&
              action.confirmed?.includes('away') === true &&
              action.confirmed.includes('home')
          ) === true
      )
    await waitForBook(savedRoster, 'the saved game roster')
    await menu('Set Team Rosters')
    await reach('Gerrit Cole')
    await shown(
      'Gerrit Cole, jersey 12, bats right, throws right, edit settings'
    )
    await tap('Cancel')
    await shown('Undo ')
    const restoredUndo = flat(await m.hierarchy()).find(
      node => node.text?.startsWith('Undo ') === true
    )?.text
    assert(restoredUndo != null)
    await tap(restoredUndo)
    await waitForBook(book => !savedRoster(book), 'the undone game roster')
    await menu('Set Team Rosters')
    // Undo reverses the game edit. The created team account still exists.
    await reach('Gerrit Cole')
    await shown(
      'Gerrit Cole, jersey 12, bats right, throws right, edit settings'
    )
    await tap('Cancel')
    for (const [label, undo] of [
      ['End Half Inning', 'Undo End half inning'],
      ['End Game', 'Undo End game']
    ]) {
      await menu(label)
      await tap(`Confirm ${label}`)
      await shown(undo)
      await tap(undo)
    }
    console.log(
      'PASS settings controls and persistence, pitch/undo boundary, player submit/reset, position pills, roster save/reopen/undo, confirmation/undo'
    )
  }
  const waitForBook = async (
    matches: (game: StoredGame) => boolean,
    description: string
  ): Promise<StoredGame> => {
    const until = Date.now() + 20000
    do {
      const book = fixture.stored()
      if (matches(book)) return book
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < until)
    throw new Error(`Timed out waiting for ${description}`)
  }
  const endGameBehavior = async (): Promise<void> => {
    await open()
    await tap('Ball')
    await menu('End Game')
    await shown('The open at-bat is saved with its pitches')
    await tap('Cancel')
    await shown('Undo Ball')
    await menu('End Game')
    await tap('Confirm End Game')
    await waitForBook(
      game =>
        game.plays.map(play => play.result.eventType).join(',') ===
          'ts_at_bat_ended,final_score' && game.currentPlay == null,
      'the interrupted at-bat and final score'
    )
    await tap('Undo End game')
    await shown('1 balls 0 strikes')
    await tap('Undo Ball')

    await tap('Swing in Play')
    await tap('Single')
    const gameId = fixture.loaded()
    const live = await waitForBook(
      game =>
        Array.isArray(game.currentPlay?.playEvents) &&
        game.currentPlay.playEvents.some(
          event => event.details?.isInPlay === true
        ),
      'the pitch in play'
    )
    await menu('End Game')
    await shown('The pitch in play is left out of the book')
    await tap('Confirm End Game')
    await waitForBook(
      game =>
        game.currentPlay == null &&
        game.plays.length === 1 &&
        game.plays[0].result.eventType === 'final_score',
      'a final score with no filed pitch'
    )
    await open(false, gameId)
    await tap('Undo Last play')
    const restored = await waitForBook(
      game => game.currentPlay != null && game.plays.length === 0,
      'the reopened batted ball'
    )
    assert.deepEqual(
      restored.currentPlay?.playEvents,
      live.currentPlay?.playEvents
    )

    await openErrorDecision()
    await tap('End Game')
    await shown('What is still undecided is left undecided')
    await tap('Cancel')
    await shown('Who committed the error')
    await tap('End Game')
    await tap('Confirm End Game')
    const filed = await waitForBook(
      game => game.currentPlay == null && game.plays.length === 2,
      'the chosen result and final score'
    )
    assert.equal(filed.plays[0].result.eventType, 'field_error')

    await open()
    await menu('Set Team Rosters')
    await shown('Roster')
    await tap('Cancel')
    await menu('End Game')
    await shown('End the game at Owls 0, Hawks 0')
    await tap('Cancel')
    await tap('More')
    await tap('Place a Runner (Tiebreaker)')
    await tap('End Game')
    await tap('Cancel')
    await shown('Place runner on base')
    await tap('End Game')
    await tap('Confirm End Game')
    await shown('Game over')
    console.log('PASS End Game, Cancel and Undo from live scoring decisions')
  }
  const field = async (): Promise<{
    rect: NonNullable<Node['bounds']>
    project: (x: number, z: number, y?: number) => { x: number; y: number }
  }> => {
    const nodes = flat(await m.hierarchy())
    const rect = (
      native
        ? nodes.find(node => node.type === 'Window')
        : (nodes.find(
            node => node.text?.startsWith('Baseball field.') === true
          ) ?? nodes.find(node => node.type === 'WebView'))
    )?.bounds
    assert(rect != null, 'Actual field viewport must be measurable')
    const camera = new PerspectiveCamera()
    applyFieldCamera(camera, {
      width: rect.width,
      height: rect.height,
      view: 'home',
      zoom: 1.25,
      tilt: (-11 * Math.PI) / 180,
      heightOffset: 33,
      bottomExtension: 112
    })
    const project = (x: number, z: number, y = 3): { x: number; y: number } => {
      const v = new Vector3(x, y, z).project(camera)
      return {
        x: rect.x + ((v.x + 1) * rect.width) / 2,
        y: rect.y + ((1 - v.y) * rect.height) / 2
      }
    }
    return { rect, project }
  }
  const placeRunner = async (): Promise<void> => {
    await tap('More')
    await tap('Place a Runner (Tiebreaker)')
    if (baseline) {
      await tap('Placed runner')
      await tap('Choose Placed runner Mike Trout')
      await tap('Destination base')
      await tap('Choose Destination base First')
      await tap('Place Runner')
    } else {
      await tap('Place runner on base')
      await tap('Place runner on 1B')
      await shown('Select Runner for 1B')
      await tap('Select runner #2 Mike Trout')
      await tap('Cancel')
    }
    await shown(
      baseline ? 'Undo Place a Runner' : 'Undo Place Mike Trout on 1B'
    )
    await new Promise(resolve => setTimeout(resolve, 4000))
  }
  const openErrorDecision = async (): Promise<void> => {
    await open()
    await tap('Swing in Play')
    await tap('Error')
    if (chromium) {
      const pointer = maestroDriver(m)
      await tapFielder(pointer, 'P')
      await setTrajectory(pointer)
    } else {
      const pitchField = await field()
      const pitcher = createPlayers().find(player => player.id === 'P')!
      const pitcherPoint = pitchField.project(
        pitcher.position.x,
        pitcher.position.z,
        5
      )
      await point(pitcherPoint.x, pitcherPoint.y)
      await shown('Drag up and down for ball trajectory')
      await new Promise(resolve => setTimeout(resolve, 2000))
      await m.dragAndDrop({
        from: {
          point: `${Math.round(pitcherPoint.x)},${Math.round(pitcherPoint.y)}`
        },
        to: {
          point: `${Math.round(pitcherPoint.x)},${Math.round(pitcherPoint.y - 15)}`
        },
        holdDuration: 100,
        duration: 500
      })
    }
    await shown('Finish defensive play')
    await tap('Finish defensive play')
    await shown('Who committed the error')
  }
  const advancedSheets = async (): Promise<void> => {
    await open()
    // Safari exposes canvas fallback text even while WebGL renders. These
    // nameplates are generated by the real scene, so they prove it mounted.
    await shown('Mike Trout')
    if (process.env.SCORING_MODAL_SECTION !== 'error') {
      await placeRunner()
      // A pitch finishes opening setup before the field gesture. On master,
      // opening defensive-assignment targets otherwise change when grabbed.
      await tap('Ball')
      await shown('Undo Ball')
      await new Promise(resolve => setTimeout(resolve, 4000))
      const { rect, project } = await field()
      // Hit the runner model at first base; its nameplate is below the
      // selectable body and the catcher has the same display name.
      const start = project(BASES[1].x, BASES[1].z, 6)
      const anchor = project(BASES[2].x, BASES[2].z, 9)
      const targets = runnerTargets(
        { x: anchor.x - rect.x, y: anchor.y - rect.y },
        rect.width,
        rect.height,
        2
      )
      await m.dragAndDrop({
        from: { point: `${Math.round(start.x)},${Math.round(start.y)}` },
        to: {
          point: `${Math.round(rect.x + targets.safe.x + 40)},${Math.round(rect.y + targets.safe.y + 33)}`
        },
        holdDuration: 700,
        duration: 1200
      })
      await shown('^Runner advance$')
      await capture('runner-advance')
      await tap('Cancel')
      await m.dragAndDrop({
        from: { point: `${Math.round(start.x)},${Math.round(start.y)}` },
        to: {
          point: `${Math.round(rect.x + targets.out.x + 40)},${Math.round(rect.y + targets.out.y + 33)}`
        },
        holdDuration: 700,
        duration: 1200
      })
      await shown('^Runner out$')
      await capture('runner-out')
      await tap('Cancel')
    }
    await openErrorDecision()
    await capture('error-credit')
    await tap('Cancel')
  }
  try {
    if (!chromium) {
      await m.stopApp({
        appId: native ? nativeAppId : 'com.apple.mobilesafari'
      })
      await m.launchApp({ stopApp: true })
      await m.setOrientation({ orientation: 'PORTRAIT' })
    }
    if (process.env.SCORING_MODAL_SECTION === 'endGame') {
      await endGameBehavior()
      return
    }
    if (process.env.SCORING_MODAL_SECTION === 'preview') {
      if (!native)
        await m.openLink({ link: required('SCORING_TEST_URL'), browser: true })
      await shown('Controlled scoring modal fixtures')
      for (const [kind, title] of [
        ['runner-advance', 'Runner advance'],
        ['runner-out', 'Runner out'],
        ['error-credit', 'Who committed the error']
      ]) {
        await tap(`Preview ${kind}`)
        await shown(title)
        await capture(kind)
        await tap('Cancel')
        if (!baseline) {
          await tap(`Preview ${kind}`)
          const choice =
            kind === 'error-credit'
              ? flat(await m.hierarchy()).find(
                  node => node.text?.startsWith('Error by ') === true
                )?.text
              : kind === 'runner-advance'
                ? 'Steal'
                : 'Caught Stealing'
          assert(choice != null)
          await tap(choice)
          await shown('Fixture event saved')
        }
      }
      console.log(
        'PASS controlled runner and error modal renderer fixtures; field gestures tested separately'
      )
      return
    }
    if (
      !['advanced', 'error', 'behavior'].includes(
        process.env.SCORING_MODAL_SECTION ?? ''
      )
    )
      await open()
    if (process.env.SCORING_MODAL_SECTION === 'exit') {
      await exitConfirmation()
      console.log('PASS permanently refused scoring edit and cancelled exit')
      return
    }
    if (process.env.SCORING_MODAL_SECTION === 'overrideNumbers') {
      assert(native, 'This regression requires native layout, not a browser')
      await menu('Overrides')
      for (const [row, label, initial] of [
        ['Owls score', 'Owls', 0],
        ['Hawks score', 'Hawks', 0],
        ['Inning', 'Inning', 1]
      ] as const) {
        // The system's wheel: its row reads the value.
        const options = Array.from({ length: 51 }, (_, i) => String(i))
        const reads = async (value: number): Promise<void> => {
          for (let tries = 0; tries < 20; tries++) {
            if (wheelValue(await wheelAt(m), options) === String(value)) return
            await m.waitForAnimationToEnd({ timeout: 1000 })
          }
          assert.fail(`${label} wheel does not read ${value}`)
        }
        await tap(row)
        await reads(initial)
        await m.waitForAnimationToEnd({ timeout: 3000 })
        const nodes = flat(await m.hierarchy())
        const title = nodes.find(node => node.text === label)?.bounds
        // The picker's frame: its wheel's bounds overhang it, for the rows
        // it curves away above and below.
        const wheel = nodes.find(node => node.type === 'Picker')?.bounds
        const done = nodes.find(node => node.text === 'Done')?.bounds
        const cancel = nodes
          .filter(node => node.text === 'Cancel')
          .at(-1)?.bounds
        assert(title != null && wheel != null && done != null && cancel != null)
        assert(title.y + title.height <= wheel.y, 'Title overlaps wheel')
        assert(wheel.height >= 132, 'Wheel must retain its three-row height')
        assert(wheel.y + wheel.height < done.y, 'Done overlaps wheel')
        assert(done.y + done.height < cancel.y, 'Cancel overlaps Done')
        await capture(`override-${label.toLowerCase()}`)
        const turn = async (): Promise<void> => {
          await turnWheel(
            m,
            async () => await wheelAt(m),
            String(initial + 1),
            options
          )
        }
        await turn()
        await tap('Cancel')
        await tap(row)
        await reads(initial)
        await turn()
        await tap('Done')
        await tap(row)
        await reads(initial + 1)
        await tap('Done')
      }
      await tap('Apply Override')
      await shown('Undo Override game state')
      console.log(
        'PASS native score/inning layout, wheel taps, Cancel, Done and Apply'
      )
      assert.deepEqual(fixture.unexpected, [])
      return
    }
    if (process.env.SCORING_MODAL_SECTION === 'settings') {
      await menu('Settings')
      await shown('Scoring sound')
      await capture('settings')
      await reach('Done')
      await tap('Done')
      return
    }
    if (process.env.SCORING_MODAL_SECTION === 'defensive') {
      await open(true)
      await tap('Assign P')
      await shown('^Assign pitcher$')
      await shown('Bench')
      await shown('Fielders')
      await capture('defensive')
      await tap('Create Player')
      await shown('First Name')
      await tap('Cancel')
      await shown('^Assign pitcher$')
      await tap('Create Player')
      await finishKeyboard()
      await reach('Create Placeholder Player')
      await tap('Create Placeholder Player')
      await shown('Select number of players to create')
      await tap('Cancel')
      await shown('First Name')
      await tap('Cancel')
      await shown('^Assign pitcher$')
      await tap('Cancel')
      await shown('Assign P')
      await tap('Assign P')
      const candidate = flat(await m.hierarchy()).find(
        node => node.text?.startsWith('Assign P #1 ') === true
      )?.text
      assert(candidate != null)
      await tap(candidate)
      await shown('Undo')
      assert(!flat(await m.hierarchy()).some(node => node.text === 'Assign P'))
      console.log(
        'PASS defensive badges, nested child cancellation and existing player assignment'
      )
      assert.deepEqual(fixture.unexpected, [])
      return
    }
    if (process.env.SCORING_MODAL_SECTION === 'behavior') {
      await behavior()
      if (!baseline) await endGameBehavior()
      assert.deepEqual(fixture.unexpected, [])
      return
    }
    if (
      ['extended', 'picker', 'forms'].includes(
        process.env.SCORING_MODAL_SECTION ?? ''
      )
    ) {
      if (process.env.SCORING_MODAL_SECTION !== 'picker') {
        await placeRunner()
        await tap(
          baseline ? 'Undo Place a Runner' : 'Undo Place Mike Trout on 1B'
        )
        await menu('Overrides')
        await tap('Owls score')
        await shown('Owls: 0')
        await shown('Done')
        await tap('Cancel')
        await tap('Cancel')
        await menu('Overrides')
        await tap('Balls 2')
        await tap('Apply Override')
        await shown('Undo Override')
        await tap('Undo Override')
      }
      if (process.env.SCORING_MODAL_SECTION === 'forms') {
        console.log(
          'PASS tiebreaker placement/Undo and override validation/Undo'
        )
        assert.deepEqual(fixture.unexpected, [])
        return
      }
      for (const count of [1, 16]) {
        await menu('Set Team Rosters')
        await tap('Create Player')
        await finishKeyboard()
        await reach('Create Placeholder Player')
        await tap('Create Placeholder Player')
        await shown('Select number of players to create')
        if (native) {
          for (let attempt = 0; attempt < 20; attempt++) {
            const wheel = flat(await m.hierarchy()).find(
              node => node.type === 'PickerWheel'
            )
            assert(wheel?.bounds != null)
            const selected = Number(wheel.text?.split(',')[0])
            assert(Number.isInteger(selected))
            if (selected === count) break
            assert(attempt < 19, 'Native picker count must be selectable')
            await point(
              wheel.bounds.x + wheel.bounds.width / 2,
              wheel.bounds.y +
                wheel.bounds.height * (selected < count ? 0.64 : 0.36)
            )
            await new Promise(resolve => setTimeout(resolve, 500))
          }
        } else {
          for (let attempt = 0; attempt < 8; attempt++) {
            const nodes = flat(await m.hierarchy())
            const wheel = nodes.find(
              node => node.text === 'Number of placeholder players'
            )?.bounds
            const target = nodes.find(
              node => node.text === `Player count ${count}`
            )?.bounds
            assert(wheel != null)
            if (
              target != null &&
              target.y >= wheel.y &&
              target.y + target.height <= wheel.y + wheel.height
            ) {
              await point(
                target.x + target.width / 2,
                target.y + target.height / 2
              )
              break
            }
            assert(attempt < 7, 'Picker maximum must be reachable')
            await m.swipe({
              startX: Math.round(wheel.x + wheel.width / 2),
              endX: Math.round(wheel.x + wheel.width / 2),
              startY: Math.round(wheel.y + wheel.height - 20),
              endY: Math.round(wheel.y + 20),
              duration: 1
            })
          }
        }
        console.log('Selected placeholder count', count)
        await tap('Create')
        await shown('Create Player')
        await tap('Cancel')
        await reach(
          count === 1 ? 'Add OWLS A to Lineup' : 'Add OWLS P to Lineup'
        )
        await shown(count === 1 ? 'OWLS A' : 'OWLS P')
        await tap('Save Rosters')
        await shown('Undo Set team roster')
        await tap('Undo Set team roster')
      }
      console.log(
        'PASS real placeholder picker minimum/maximum and roster save/Undo'
      )
      if (process.env.SCORING_MODAL_SECTION === 'extended')
        console.log(
          'PASS tiebreaker placement/Undo, Overrides validation/apply/Undo'
        )
      assert.deepEqual(fixture.unexpected, [])
      return
    }
    if (process.env.SCORING_MODAL_SECTION === 'placeholder') {
      await menu('Set Team Rosters')
      await tap('Create Player')
      await shown('First Name')
      await finishKeyboard()
      await reach('Create Placeholder Player')
      await tap('Create Placeholder Player')
      await shown('Select number of players to create')
      await capture('placeholders')
      await tap('Cancel')
      await tap('Cancel')
      await tap('Cancel')
      return
    }
    if (
      process.env.SCORING_MODAL_SECTION == null ||
      ['player', 'basic'].includes(process.env.SCORING_MODAL_SECTION ?? '')
    ) {
      if (process.env.SCORING_MODAL_SECTION !== 'player') {
        await menu('Settings')
        await shown('^Scoring sound$')
        await capture('settings')
        await reach('Done')
        await tap('Done')
      }
      await menu('Set Team Rosters')
      await shown('^Save Rosters$')
      await tap('Lineup')
      await capture('roster-lineup')
      await tap('Defense')
      await capture('roster-defense')
      await tap('Roster')
      await reach('Create Player')
      await tap('Create Player')
      await shown('^First Name$')
      await capture('create-player')
      await finishKeyboard()
      await reach('Create Player')
      await tap('Create Player')
      await shown('Enter a player name')
      await capture('player-validation')
      await reach('Create Placeholder Player')
      await tap('Create Placeholder Player')
      await shown('Select number of players to create')
      await capture('placeholders')
      await tap('Cancel')
      await tap('Cancel')
      await tap('Cancel')
    }
    if (
      !['advanced', 'error'].includes(process.env.SCORING_MODAL_SECTION ?? '')
    ) {
      await tap('More')
      await tap('Place a Runner (Tiebreaker)')
      await shown(baseline ? '^Placed runner$' : '^Place runner on base$')
      await capture('tiebreaker')
      await tap('Cancel')
      for (const [label, state] of [
        ['Overrides', 'overrides'],
        ['End Half Inning', 'end-half'],
        ['End Game', 'end-game']
      ]) {
        await menu(label)
        await capture(state)
        await tap('Cancel')
      }
      await exitConfirmation()
    }
    if (
      ['basic', 'player', 'additional'].includes(
        process.env.SCORING_MODAL_SECTION ?? ''
      )
    ) {
      if (!baseline && process.env.SCORING_MODAL_SECTION === 'basic')
        await behavior()
      assert.deepEqual(fixture.unexpected, [])
      console.log('PASS core scoring modal captures and behaviors')
      return
    }
    if (['advanced', 'error'].includes(process.env.SCORING_MODAL_SECTION ?? ''))
      await advancedSheets()
    await open(true)
    await tap('Assign P')
    await shown('^Assign pitcher$')
    await capture('defensive')
    await tap('Cancel')
    if (!baseline) await behavior()
    console.log(
      'PASS modal shell, Settings, roster, player validation, placeholder picker, tiebreaker and confirmation captures'
    )
    assert.deepEqual(fixture.unexpected, [])
  } finally {
    try {
      try {
        const debug = process.env.SCORING_DEBUG_DIR
        if (debug != null) {
          await writeFile(join(debug, 'last-screen.png'), await m.screenshot())
          await writeFile(
            join(debug, 'last-hierarchy.json'),
            JSON.stringify(await m.hierarchy(), null, 2)
          )
        }
        if (!chromium) await m.setOrientation({ orientation: 'PORTRAIT' })
      } finally {
        await browser?.disconnect()
        await m.detach()
      }
    } finally {
      try {
        if (chromium) await daemon.shutdown()
        else daemon.close()
      } finally {
        await fixture.close()
      }
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
