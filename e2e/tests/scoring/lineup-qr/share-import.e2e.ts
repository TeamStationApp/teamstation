import { strict as assert } from 'node:assert'

import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessScenario } from '../../../core/spec'
import { stackSql } from '../../../rigs/coach/coachApp'
import {
  type Node,
  pause,
  SCORER_ROLE,
  textOf
} from '../../../rigs/scoring/scorerSheets'
import {
  beginRoster,
  playsOf,
  type Roster
} from '../roster-edit/player-settings.e2e'

/**
 * Lineup QR share and import on the scorekeeper's Set Team Rosters screen,
 * on Safari on an iPhone and in the develop app on an iPhone and an Android
 * phone: the share row and the footer, the away lineup's code, the web's
 * word that it cannot scan, and in the app a lineup code read through the
 * scan step's payload field, saved, read again, partly reused, cancelled,
 * and refused when it is no lineup. What was saved is read back from the
 * book and the game's guests on the stack.
 */

/** The Roster tab's row that opens Share Lineup. */
const SHARE = 'Share or import team lineup'

async function tapRosterTab(run: Roster): Promise<void> {
  const { s } = run
  await s.m.waitForAnimationToEnd({ timeout: 3000 })
  await s.shown('Roster')
  const tab = (await s.nodes())
    .filter(node => textOf(node) === 'Roster' && node.bounds != null)
    .sort((a, b) => a.bounds!.y - b.bounds!.y)[0]
  await s.point(
    tab.bounds!.x + tab.bounds!.width / 2,
    tab.bounds!.y + tab.bounds!.height / 2
  )
}

async function shownNode(run: Roster, label: string): Promise<Node> {
  const end = Date.now() + 30000
  for (;;) {
    const node = await run.s.find(label)
    if (node != null) return node
    if (Date.now() > end) throw new Error(`Not on screen: ${label}`)
    await pause()
  }
}

async function openRosters(run: Roster): Promise<void> {
  const { s } = run
  await s.open(`games/${run.game}/score`)
  await s.shown('Open scoring menu', 60000)
  // The first tap can land before the page has hydrated: tap until the
  // menu answers.
  for (let attempt = 0; attempt < 6; attempt++) {
    await s.tap('Open scoring menu')
    if ((await s.find('Set Team Rosters')) != null) break
    await pause(1500)
  }
  await s.tap('Set Team Rosters')
  await shownNode(run, 'Save Rosters')
}

async function openShare(run: Roster): Promise<void> {
  await tapRosterTab(run)
  await run.s.tap(SHARE)
}

async function openScan(run: Roster): Promise<void> {
  await openShare(run)
  await shownNode(run, 'Share/Import Lineup')
  await run.s.tap('Scan QR code to import lineup')
  await shownNode(run, 'Import Lineup')
}

/** Every roster setup the book holds, in order. */
async function savedSetups(run: Roster): Promise<any[]> {
  const { storedRecordOf } =
    await import('../../../../src/common/scoring/gumbo')
  return playsOf(await run.book())
    .flatMap(play => storedRecordOf(play)?.actions ?? [])
    .flatMap((action: any) =>
      action.type === 'lineup' &&
      action.kind === 'roster' &&
      action.setup != null
        ? [action.setup]
        : []
    )
}

const awayOrder = (setup: any): string[] =>
  setup.sides.away.battingOrder.map((id: string) => setup.players[id].fullName)

/** Types a code into the scan step's payload field and reads it. */
async function inject(run: Roster, text: string): Promise<void> {
  const { s } = run
  if (s.surface === 'android-app') {
    // Typed key by key, Android's keyboard drops the scan sheet part way
    // through a long code; set on the field by its id, it arrives whole.
    await s.m.inputText({ text, id: 'lineupQrPayload' })
  } else {
    await s.tap('QR payload')
    await s.m.eraseText({ characters: 2000 })
    // A long string typed at once loses a character now and then: short
    // runs arrive whole.
    for (let at = 0; at < text.length; at += 48)
      await s.m.inputText({ text: text.slice(at, at + 48) })
    await s.m.hideKeyboard()
  }
  await s.tap('Inject')
  await pause(800)
}

/** W1: the share row leads the Roster tab; the footer is one row. */
async function footer(run: Roster): Promise<void> {
  const { s } = run
  await openRosters(run)
  await s.capture('roster-footer-scorekeeper')
  await tapRosterTab(run)
  await shownNode(run, SHARE)
  const save = (await shownNode(run, 'Save Rosters')).bounds!
  const cancel = (await shownNode(run, 'Cancel')).bounds!
  assert(
    !(await s.texts()).includes('Share Lineup'),
    'Share Lineup has left the footer'
  )
  assert(
    Math.abs(cancel.y + cancel.height / 2 - (save.y + save.height / 2)) < 4,
    'Cancel is on Save Rosters’ row'
  )
  // The Away/Home slider spans the sheet, so its ends give the middle, where
  // the microphone sits: Cancel is left of it, Save right of it.
  const away = (await shownNode(run, 'Away Team')).bounds!
  const home = (await shownNode(run, 'Home Team')).bounds!
  const middle = (away.x + home.x + home.width) / 2
  assert(
    cancel.x + cancel.width <= middle && cancel.x < save.x,
    'Cancel is left of the middle'
  )
  assert(save.x + save.width / 2 > middle + 20, 'Save is right of it')
  assert(
    Math.abs(cancel.width - save.width) < 2 &&
      Math.abs(cancel.height - save.height) < 2,
    `Cancel is as large as Save Rosters (${cancel.width}×${cancel.height}, ${save.width}×${save.height})`
  )
  await s.capture('share-row')
}

/** N1–N5: a lineup code read through the payload field, in the app. */
async function imports(run: Roster): Promise<void> {
  const { s, ctx } = run
  const { lineupQrFixture2, lineupQrFixture4 } =
    await import('../../../../src/app/scoring/lineupQr.fixtures')
  // N1: the scan step, with the payload field a build without a camera
  // offers, and no permission dialog.
  await openScan(run)
  try {
    await shownNode(run, 'QR payload')
  } catch {
    await s.capture('scan-no-payload')
    throw new BlockedError(
      'the scan step offers its QR payload field only in a development build or on a phone with no camera; this build on this phone shows the camera, which no code is held up to'
    )
  }
  await shownNode(run, 'Camera unavailable')
  await shownNode(run, 'Inject')
  assert(
    !(await s.texts()).some(text =>
      /^(Allow|While using the app|Allow While Using App)$/i.test(text)
    ),
    'No permission dialog'
  )
  await s.capture('scan')

  // N2: a lineup of new players, saved. All twelve roster players start in
  // the order: the eleven scanned batters bench the first eleven, and the
  // twelfth keeps his slot after them.
  const before = (await savedSetups(run)).length
  await inject(run, lineupQrFixture4.text)
  await s.gone('Import Lineup')
  await s.shown('Imported 12 players · 11 benched')
  await s.capture('import')
  await s.tap('Save Rosters')
  const end = Date.now() + 30000
  while ((await savedSetups(run)).length === before && Date.now() < end)
    await pause(250)
  const saved = (await savedSetups(run)).at(-1)
  assert(saved != null, 'Save Rosters saved the imported lineup')
  assert.deepEqual(
    awayOrder(saved).slice(0, lineupQrFixture4.lineup.h.length),
    lineupQrFixture4.lineup.h.map(player => `${player.f} ${player.l}`)
  )
  assert.equal(awayOrder(saved).length, lineupQrFixture4.lineup.h.length + 1)
  const guests = await stackSql(
    ctx,
    'select count(*)::int as made from game_guest_details where game_id = $1',
    [run.game]
  )
  assert.equal(
    guests.rows[0].made,
    12,
    'Each scanned player was made a guest once'
  )
  const pitcher = saved.sides.away.defense.P
  assert(pitcher != null && saved.players[pitcher].fullName === 'Gerrit Cole')
  assert(saved.sides.away.battingOrder.includes(pitcher) === false)

  // N3: the same code again changes nothing.
  await openRosters(run)
  await openScan(run)
  await inject(run, lineupQrFixture4.text)
  await s.gone('Import Lineup')
  await s.shown('Imported 12 players')
  assert(
    !(await s.texts()).some(text => text.includes('benched')),
    'Nothing is benched the second time'
  )
  // The button's own node carries `enabled`; its label's text node does not.
  const saves = (await s.nodes()).filter(
    node =>
      (textOf(node) === 'Save Rosters' || node.id === 'Save Rosters') &&
      node.enabled !== undefined
  )
  assert(
    saves.length > 0 && saves.every(node => node.enabled === false),
    `Save Rosters stays off: the draft is the saved lineup (${JSON.stringify(saves.map(node => node.enabled))})`
  )
  await s.tap('Cancel')
  await s.gone('Save Rosters')

  // N4: a roster player in the code is reused; Cancel keeps the saved order.
  await openRosters(run)
  await openScan(run)
  await inject(run, lineupQrFixture2.text)
  await s.gone('Import Lineup')
  const lines = await s.texts()
  // The scorekeeper reads the roster's names in full.
  assert(
    lines.some(text => /^1\. #1 Mookie Betts$/.test(text)),
    'Mookie Betts leads off'
  )
  assert.equal(
    lines.filter(text => text.includes('Mookie')).length,
    1,
    'No second Mookie'
  )
  // Fixture 2 puts Marcus Semien at SS, so N2's SS leaves the order.
  assert(
    !lines.some(text => /^\d+\. #11 José Ramírez$/.test(text)),
    'José Ramírez is out of the order'
  )
  await s.tap('Cancel')
  await s.gone('Save Rosters')
  await openRosters(run)
  assert(
    (await s.texts()).some(text => /^1\. #5 Corey Seager$/.test(text)),
    'The order saved in N2 is back'
  )

  // N5: codes that are not lineups raise the yellow sheet.
  const { deflateSync } = await import('fflate')
  const { base64 } = await import('rfc4648')
  const { utf8 } = await import('../../../../src/app/walkup/localFileId')
  await openScan(run)
  await inject(run, 'hello')
  await s.shown('That QR code is not a GameChanger lineup.')
  await s.capture('bad-scan')
  await s.tap('Scan Again')
  await s.gone('That QR code is not a GameChanger lineup.')
  await inject(
    run,
    base64.stringify(deflateSync(utf8(JSON.stringify({ e: 'x', t: 'y' }))))
  )
  await s.shown('That lineup QR code could not be read.')
  await s.tap('Scan Again')
  await s.tap('Cancel')
}

function scenario(all: boolean): HarnessScenario {
  return async ctx => {
    const run = await beginRoster(ctx)
    const { s } = run
    await footer(run)
    if (!all) return
    // W2 / N6: the chooser, then the away lineup's QR code.
    await openShare(run)
    await shownNode(run, 'Share/Import Lineup')
    await shownNode(run, 'Generate QR to share lineup')
    await shownNode(run, 'Scan QR code to import lineup')
    assert(
      (await s.texts()).includes('Owls'),
      'The chooser names the away team'
    )
    if (!s.native) await s.capture('chooser')
    await s.tap('Generate QR to share lineup')
    await shownNode(run, 'Share Lineup')
    await shownNode(run, 'Lineup QR code')
    await s.capture('share-qr')
    await s.tap('Cancel')
    await s.gone('Lineup QR code')
    if (!s.native) {
      // W3: the web says it cannot scan.
      await openShare(run)
      await s.tap('Scan QR code to import lineup')
      await s.shown(
        'Unsupported on the web version of TeamStation. Please download the app.'
      )
      await s.capture('scan-unsupported-web')
      await s.tap('Cancel')
      await s.gone('Import Lineup')
      // W4: the chooser follows the slider to the home team.
      await s.tap('Home Team')
      await openShare(run)
      await shownNode(run, 'Share/Import Lineup')
      // The slider names Hawks once; the chooser's title is the second.
      assert(
        (await s.texts()).filter(text => text === 'Hawks').length >= 2,
        'The chooser names the home team'
      )
      await s.tap('Cancel')
      return
    }
    await imports(run)
  }
}

export default defineHarness({
  id: 'scoring/lineup-qr/share-import',
  title:
    'A lineup is shared as a QR code and imported from one on the roster screen',
  kind: 'e2e',
  covers: [
    'src/app/scoring/LineupShareSheet.tsx',
    'src/app/scoring/lineupQrCodec.ts',
    'src/app/scoring/lineupQrImport.ts',
    'src/app/scoring/lineupQrExport.ts',
    'src/app/scoring/ScoringScreen.tsx',
    'src/server/games/guestPlayers.ts'
  ],
  stack: 'isolated',
  fixtures: ['roster-edit'],
  exclusive: false,
  surfaces: {
    // The roster sheet sits over the 3D field: a GPU, so physical phones.
    'web-safari-ios': {
      devices: [
        { role: SCORER_ROLE, needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    },
    'ios-app': {
      devices: [
        { role: SCORER_ROLE, needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    },
    'android-app': {
      devices: [
        {
          role: SCORER_ROLE,
          needs: ['android-phone', 'gpu'],
          simulator: 'never'
        }
      ]
    }
  },
  services: [],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 15,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    footer: scenario(false),
    'share-and-scan': scenario(true)
  }
})
