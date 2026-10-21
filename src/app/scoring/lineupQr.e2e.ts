import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { deflateSync } from 'fflate'
import { base64 } from 'rfc4648'

import { recordOf } from '../../common/scoring/gumbo'
import type { GameSetup } from '../../common/scoring/state'
import { utf8 } from '../walkup/localFileId'
import { lineupQrFixture2, lineupQrFixture4 } from './lineupQr.fixtures'
import { rosterEditFixture } from './scoringRosterEdit.e2e.fixture'

/**
 * Lineup QR share and import on the scorekeeper's Set Team Rosters screen,
 * end to end through maestro-d, on Safari or the app on an iPhone simulator
 * or an Android emulator, against `rosterEditFixture`.
 *
 *   LINEUP_QR_SURFACE   safari | ios | android
 *   LINEUP_QR_SECTION   footer | all (default all)
 *   LINEUP_QR_PHASE     before | after (default after): names the footer shot
 *   LINEUP_QR_ARTIFACT_DIR, MAESTRO_D, MAESTRO_D_CLIENT_ROOT,
 *   SCORING_DEVICE_UDID, SCORING_FIXTURE_PORT, SCORING_ASSET_URL,
 *   SCORING_TEST_URL (Safari only); TS_TEST_DATABASE_URL is optional, as it
 *   is for the fixture.
 *
 * A simulator and an emulator have no camera, so the scan step offers its
 * payload field, and the scenarios inject QR text through it.
 */
const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
const clientRequire = createRequire(
  join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
)
const { MaestroD } = clientRequire('maestro-d')

interface Node {
  text?: string
  id?: string
  type?: string
  enabled?: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
const flat = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flat)
]
/** The Roster tab's row that opens Share Lineup. */
const SHARE = 'Share or import team lineup'
const pause = async (ms = 500): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const surface = required('LINEUP_QR_SURFACE')
  assert(['safari', 'ios', 'android'].includes(surface))
  const native = surface !== 'safari'
  const android = surface === 'android'
  const section = process.env.LINEUP_QR_SECTION ?? 'all'
  const phase = process.env.LINEUP_QR_PHASE ?? 'after'
  assert(['footer', 'all'].includes(section))
  assert(['before', 'after'].includes(phase))
  const artifacts = resolve(required('LINEUP_QR_ARTIFACT_DIR'))
  const device = required('SCORING_DEVICE_UDID')
  await mkdir(artifacts, { recursive: true })
  const fixture = await rosterEditFixture(
    required('SCORING_ASSET_URL'),
    Number(required('SCORING_FIXTURE_PORT'))
  )
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  }).catch(async (error: unknown) => {
    await fixture.close()
    throw error
  })
  const appId = native ? 'app.teamstation.app' : 'com.apple.mobilesafari'
  const m = await daemon
    .attach({
      device,
      platform: android ? 'android' : 'ios',
      appId,
      artifacts: 'on-failure',
      waitForIdleTimeout: 500,
      stepDelay: 250
    })
    .catch(async (error: unknown) => {
      daemon.close()
      await fixture.close()
      throw error
    })
  const nodes = async (): Promise<Node[]> => {
    const all = flat(await m.hierarchy())
    return native
      ? all
      : flat(all.find(node => node.type === 'WebView') ?? { children: all })
  }
  const find = async (label: string): Promise<Node | undefined> =>
    (await nodes())
      .filter(
        node =>
          (node.text === label ||
            node.id === label ||
            node.text?.startsWith(label + ',') === true) &&
          node.bounds != null
      )
      .at(-1)
  const shown = async (label: string, timeout = 30000): Promise<Node> => {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      const node = await find(label)
      if (node != null) return node
      await pause()
    }
    assert.fail(`Missing visible control: ${label}`)
  }
  const point = async (x: number, y: number): Promise<void> => {
    await m.tapOnPoint({ x: Math.round(x), y: Math.round(y), duration: 100 })
    await pause()
  }
  const tap = async (label: string): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    const node = await shown(label)
    const box = node.bounds!
    console.log('Tap', label, box)
    await point(box.x + box.width / 2, box.y + box.height / 2)
  }
  /** The Roster tab, above the Lineup tab's "Roster" column heading. */
  const tapRosterTab = async (): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    await shown('Roster')
    const tab = (await nodes())
      .filter(node => node.text === 'Roster' && node.bounds != null)
      .sort((a, b) => a.bounds!.y - b.bounds!.y)[0]
    console.log('Tap Roster tab', tab.bounds)
    await point(
      tab.bounds!.x + tab.bounds!.width / 2,
      tab.bounds!.y + tab.bounds!.height / 2
    )
  }
  /** The WebDriverAgent session of an iOS device, for its `/url` call. */
  const driver = async (): Promise<string> => {
    const log = await readFile(join(daemon.info.runDir, 'daemon.log'), 'utf8')
    const line = log
      .split('\n')
      .filter(value =>
        value.includes(`Starting WDA on device ${device} (port:`)
      )
      .at(-1)
    const port = /\(port: (\d+)\)/.exec(line ?? '')?.[1]
    assert(port != null)
    const endpoint = `http://127.0.0.1:${port}`
    const status = await m.eval(
      `http.get(${JSON.stringify(endpoint + '/status')})`
    )
    const session = JSON.parse(status.body).sessionId
    assert(typeof session === 'string')
    return endpoint + '/session/' + session
  }
  const open = async (path: string): Promise<void> => {
    if (android) {
      await m.openLink({ link: `teamstation://${path}` })
      await pause(1500)
      return
    }
    const link = native
      ? `teamstation://${path}`
      : `${required('SCORING_TEST_URL')}/${path}`
    const result = await m.eval(
      `http.post(${JSON.stringify((await driver()) + '/url')},{body:${JSON.stringify({ url: link, bundleId: appId, idleTimeoutMs: 1500 })}})`
    )
    assert.equal(result.status, 200)
    assert(JSON.parse(result.body).value?.error == null)
    await pause()
  }
  const dismissWarnings = async (): Promise<void> => {
    if (!native) return
    const warning = (await nodes()).find(
      node => node.text?.includes('Open debugger to view warnings.') === true
    )
    if (warning?.bounds != null)
      await point(
        warning.bounds.x + warning.bounds.width - 22,
        warning.bounds.y + warning.bounds.height / 2
      )
  }
  const capture = async (name: string): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    await dismissWarnings()
    await pause(400)
    await writeFile(join(artifacts, `${name}.png`), await m.screenshot())
    console.log('Captured', name)
  }
  const openRosters = async (): Promise<void> => {
    await open(`games/${fixture.gameId}/score`)
    await shown('Open scoring menu', 60000)
    // The first tap can land before the page has hydrated; tap until the
    // menu answers.
    for (let attempt = 0; attempt < 6; attempt++) {
      await tap('Open scoring menu')
      if ((await find('Set Team Rosters')) != null) break
      await pause(1500)
    }
    await tap('Set Team Rosters')
    await shown('Save Rosters')
    await dismissWarnings()
  }

  const texts = async (): Promise<string[]> =>
    (await nodes()).flatMap(node => (node.text == null ? [] : [node.text]))
  const gone = async (label: string, timeout = 15000): Promise<void> => {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      if ((await find(label)) == null) return
      await pause()
    }
    assert.fail(`Still visible: ${label}`)
  }
  const savedSetups = (): GameSetup[] =>
    [
      ...fixture.stored().plays,
      ...(fixture.stored().currentPlay == null
        ? []
        : [fixture.stored().currentPlay!])
    ]
      .flatMap(play => recordOf(play)?.actions ?? [])
      .flatMap(action =>
        action.type === 'lineup' &&
        action.kind === 'roster' &&
        action.setup != null
          ? [action.setup]
          : []
      )
  const awayOrder = (setup: GameSetup): string[] =>
    setup.sides.away.battingOrder.map(id => setup.players[id].fullName)
  /** Types a code into the scan step's payload field and injects it. */
  const inject = async (text: string): Promise<void> => {
    if (android) {
      // Typed key by key, Android's keyboard drops the scan sheet part way
      // through a long code; set on the field by its label, it arrives whole.
      await m.inputText({ text, id: 'lineupQrPayload' })
    } else {
      await tap('QR payload')
      await m.eraseText({ characters: 2000 })
      // The simulator's keyboard drops a character now and then from a long
      // string typed at once; short runs arrive whole.
      for (let at = 0; at < text.length; at += 48)
        await m.inputText({ text: text.slice(at, at + 48) })
      await m.hideKeyboard()
    }
    await tap('Inject')
    await pause(800)
  }
  /** The Roster tab's first row opens Share Lineup. */
  const openShare = async (): Promise<void> => {
    await tapRosterTab()
    await tap(SHARE)
  }
  const openScan = async (): Promise<void> => {
    await openShare()
    await shown('Share/Import Lineup')
    await tap('Scan QR code to import lineup')
    await shown('Import Lineup')
  }

  try {
    if (native) await m.stopApp()
    await m.launchApp()
    await openRosters()
    // The before and after pair is Safari's; a phone's footer has a name of its own.
    await capture(
      native
        ? `roster-footer-scorekeeper-${surface}`
        : `roster-footer-scorekeeper-${phase}`
    )
    if (phase === 'after') {
      // The share row leads the Roster tab; the footer is Create Player and
      // Save Rosters over a Cancel in the middle.
      await tapRosterTab()
      await shown(SHARE)
      const save = (await shown('Save Rosters')).bounds!
      const cancel = (await shown('Cancel')).bounds!
      assert(
        !(await texts()).includes('Share Lineup'),
        'Share Lineup has left the footer'
      )
      assert(cancel.y >= save.y + save.height - 1, 'Cancel is below Save')
      // The Away/Home slider spans the sheet, so its ends give the middle.
      // On iOS and in Safari "Cancel" is its whole stretched button, so only
      // the centre is compared; it sat under Save Rosters, right of here.
      const away = (await shown('Away Team')).bounds!
      const home = (await shown('Home Team')).bounds!
      const middle = (away.x + home.x + home.width) / 2
      assert(
        Math.abs(cancel.x + cancel.width / 2 - middle) < 3,
        'Cancel is in the middle'
      )
      assert(
        Math.abs(save.x + save.width / 2 - middle) > 20,
        'Cancel is not under Save Rosters'
      )
      await capture(`share-row-${surface}`)
      console.log('PASS W1 footer')
    }
    if (section === 'footer') return

    // W2 / N6: the chooser, then the away lineup's QR code.
    await openShare()
    await shown('Share/Import Lineup')
    await shown('Generate QR to share lineup')
    await shown('Scan QR code to import lineup')
    assert((await texts()).includes('Owls'), 'The chooser names the away team')
    if (!native) await capture('chooser')
    await tap('Generate QR to share lineup')
    await shown('Share Lineup')
    await shown('Lineup QR code')
    await capture(native ? `share-qr-${surface}` : 'share-qr-web')
    await tap('Cancel')
    await gone('Lineup QR code')
    console.log('PASS W2/N6 generate')

    if (!native) {
      // W3: the web says it cannot scan.
      await openShare()
      await tap('Scan QR code to import lineup')
      await shown(
        'Unsupported on the web version of TeamStation. Please download the app.'
      )
      await capture('scan-unsupported-web')
      await tap('Cancel')
      await gone('Import Lineup')
      console.log('PASS W3 unsupported scan')
      // W4: the chooser follows the slider to the home team.
      await tap('Home Team')
      await openShare()
      await shown('Share/Import Lineup')
      // The slider names Hawks once; the chooser's title is the second.
      assert(
        (await texts()).filter(text => text === 'Hawks').length >= 2,
        'The chooser names the home team'
      )
      await tap('Cancel')
      console.log('PASS W4 home side')
      return
    }

    // N1: no camera, so the payload field, and no permission dialog.
    await openScan()
    await shown('Camera unavailable')
    await shown('QR payload')
    await shown('Inject')
    assert(
      !(await texts()).some(text =>
        /^(Allow|While using the app|Allow While Using App)$/i.test(text)
      ),
      'No permission dialog'
    )
    await capture(`scan-${surface}`)
    console.log('PASS N1 no camera')

    // N2: inject a lineup of new players, then save it. All twelve roster
    // players start in the order: the eleven scanned batters bench the first
    // eleven, and the twelfth keeps his slot after them.
    const before = savedSetups().length
    await inject(lineupQrFixture4.text)
    await gone('Import Lineup')
    await shown('Imported 12 players · 11 benched')
    await capture(`import-${surface}`)
    await tap('Save Rosters')
    const until = Date.now() + 30000
    while (savedSetups().length === before && Date.now() < until)
      await pause(250)
    const saved = savedSetups().at(-1)!
    assert.deepEqual(
      awayOrder(saved).slice(0, lineupQrFixture4.lineup.h.length),
      lineupQrFixture4.lineup.h.map(player => `${player.f} ${player.l}`)
    )
    assert.equal(awayOrder(saved).length, lineupQrFixture4.lineup.h.length + 1)
    assert.equal(
      fixture.trace.filter(line => line.startsWith('Guest ')).length,
      12,
      'Each scanned player was made a guest once'
    )
    const pitcher = saved.sides.away.defense.P
    assert(pitcher != null && saved.players[pitcher].fullName === 'Gerrit Cole')
    assert(!saved.sides.away.battingOrder.includes(pitcher))
    console.log('PASS N2 import and save')

    // N3: the same code again changes nothing.
    await openRosters()
    await openScan()
    await inject(lineupQrFixture4.text)
    await gone('Import Lineup')
    await shown('Imported 12 players')
    assert(
      !(await texts()).some(text => text.includes('benched')),
      'Nothing is benched the second time'
    )
    // The button's own node carries `enabled`; its label's text node does not.
    const saves = (await nodes()).filter(
      node =>
        (node.text === 'Save Rosters' || node.id === 'Save Rosters') &&
        node.enabled !== undefined
    )
    assert(
      saves.length > 0 && saves.every(node => node.enabled === false),
      `Save Rosters stays off: the draft is the saved lineup (${JSON.stringify(saves.map(node => node.enabled))})`
    )
    await tap('Cancel')
    await gone('Save Rosters')
    console.log('PASS N3 idempotent')

    // N4: a roster player in the code is reused; Cancel keeps the saved order.
    await openRosters()
    await openScan()
    await inject(lineupQrFixture2.text)
    await gone('Import Lineup')
    const lines = await texts()
    assert(
      lines.some(text => /^1\. #1 Mookie B$/.test(text)),
      'Mookie B leads off'
    )
    assert(
      !lines.some(text => text.includes('Mookie Betts')),
      'No second Mookie'
    )
    // Fixture 2 puts Marcus Semien at SS, so N2's SS leaves the order for the
    // bench (that he stays in the game is the import's unit test).
    assert(
      !lines.some(text => /^\d+\. #11 José Ramírez$/.test(text)),
      'José Ramírez is out of the order'
    )
    await tap('Cancel')
    await gone('Save Rosters')
    await openRosters()
    assert(
      (await texts()).some(text => /^1\. #5 Corey Seager$/.test(text)),
      'The order saved in N2 is back'
    )
    console.log('PASS N4 reuse and cancel')

    // N5: codes that are not lineups raise the yellow sheet.
    await openScan()
    await inject('hello')
    await shown('That QR code is not a GameChanger lineup.')
    await capture(`bad-scan-${surface}`)
    await tap('Scan Again')
    await gone('That QR code is not a GameChanger lineup.')
    await inject(
      base64.stringify(deflateSync(utf8(JSON.stringify({ e: 'x', t: 'y' }))))
    )
    await shown('That lineup QR code could not be read.')
    await tap('Scan Again')
    await tap('Cancel')
    console.log('PASS N5 bad scans')
  } finally {
    await m.detach().catch(() => undefined)
    daemon.close()
    await fixture.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
