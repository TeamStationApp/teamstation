import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asRosterEntry } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import {
  after,
  game as scoringGame,
  strikeout,
  walk
} from '../../test/scoringGames'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { lineupQrFixture4 } from './lineupQr.fixtures'
import { encodeLineupQr } from './lineupQrCodec'
import { lineupQrOf } from './lineupQrExport'
import type { CreateGuest, LineupQrResult } from './lineupQrImport'
import { qrMatrix } from './lineupQrMatrix'
import {
  lineupQrOpeningStep,
  LineupShareSheet,
  shareQrSize
} from './LineupShareSheet'
import { QrScanner, qrScannerSupported } from './qrScanner'
import { type QrScannerProps, qrScannerStatusOf } from './qrScannerProps'
import type { ScoringSessionState } from './scoringTypes'

let root: Root | undefined
const node = (label: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const all = (label: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)
]
const text = (): string => document.body.textContent ?? ''
const click = async (label: string): Promise<void> => {
  const found = node(label)
  expect(found, label).not.equals(null)
  await act(async () => {
    found!.click()
  })
}
const clickText = async (label: string): Promise<void> => {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(button => button.textContent === label)
  expect(found, label).not.equals(undefined)
  await act(async () => {
    found!.click()
  })
}
const type = async (label: string, value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(node(label), value)
    node(label)!.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

/** A camera the test drives: it holds the props the sheet gave it. */
const camera: { props?: QrScannerProps; mounted: number } = { mounted: 0 }
function FakeScanner(props: QrScannerProps): null {
  camera.props = props
  React.useEffect(() => {
    camera.mounted++
  }, [])
  return null
}
const report = async (call: (props: QrScannerProps) => void): Promise<void> => {
  await act(async () => {
    call(camera.props!)
  })
}

const session = (): ScoringSessionState =>
  createDevelopmentSession(gameFixture, [], [])
let nextGuest = 1000
/** The server's guest creation: each guest a new gumbo id. */
export const createGuest: CreateGuest = async (_side, player) =>
  asRosterEntry({
    userId: userIdOfGumbo(nextGuest),
    gumboId: nextGuest++,
    shortName: `${player.firstName} ${player.lastName}`,
    jersey: player.jersey,
    bats: null,
    throws: null,
    positions: [],
    isPlayer: false,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null
  })
const mount = async (
  props: Partial<React.ComponentProps<typeof LineupShareSheet>> = {}
): Promise<{ imports: LineupQrResult[]; closes: number[] }> => {
  const imports: LineupQrResult[] = []
  const closes: number[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <LineupShareSheet
          side="away"
          draft={session()}
          roster={[]}
          scanner={FakeScanner}
          scannerSupported
          devBuild={false}
          onCreateGuest={createGuest}
          onImport={result => imports.push(result)}
          onClose={() => closes.push(1)}
          {...props}
        />
      </ThemeProvider>
    )
  })
  return { imports, closes }
}

describe('lineup QR share sheet', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    camera.props = undefined
    camera.mounted = 0
    document.body.innerHTML = ''
  })

  it('opens on the code or the camera when the side allows only one', async function () {
    expect(lineupQrOpeningStep('both', true)).equals('choose')
    expect(lineupQrOpeningStep('share', false)).equals('share')
    expect(lineupQrOpeningStep('scan', true)).equals('scan')
    expect(lineupQrOpeningStep('scan', false)).equals('unsupported')
    await mount({ offer: 'share' })
    expect(text()).includes('Share Lineup')
    expect(document.querySelector('svg[data-testid="qrCode"]')).not.equals(null)
    expect(node('Generate QR to share lineup')).equals(null)
    expect(node('Scan QR code to import lineup')).equals(null)
    await act(async () => {
      root?.unmount()
    })
    document.body.innerHTML = ''
    await mount({ offer: 'scan' })
    expect(text()).includes('Import Lineup')
    expect(node('Camera starting')).not.equals(null)
    expect(node('Generate QR to share lineup')).equals(null)
    expect(document.querySelector('svg[data-testid="qrCode"]')).equals(null)
  })

  it('holds a scan-only camera until the roster has loaded', async function () {
    await mount({ offer: 'scan', rosterLoading: true })
    expect(text()).includes('Loading the team roster…')
    expect(camera.props).equals(undefined)
    await act(async () => {
      root?.unmount()
    })
    document.body.innerHTML = ''
    await mount({ offer: 'scan', rosterError: 'Unable to load the roster.' })
    expect(text()).includes('Unable to load the roster.')
    expect(camera.props).equals(undefined)
    await act(async () => {
      root?.unmount()
    })
    document.body.innerHTML = ''
    await mount({ offer: 'scan', scannerSupported: false })
    expect(text()).includes(
      'Unsupported on the web version of TeamStation. Please download the app.'
    )
    expect(camera.props).equals(undefined)
  })

  it('offers both rows under the team name', async function () {
    await mount()
    expect(text()).includes('Owls')
    expect(text()).includes('Share/Import Lineup')
    expect(node('Generate QR to share lineup')).not.equals(null)
    expect(node('Scan QR code to import lineup')).not.equals(null)
    expect(
      document.querySelector('[data-testid="lineupQrGlyph-qr"]')
    ).not.equals(null)
    expect(
      document.querySelector('[data-testid="lineupQrGlyph-scan"]')
    ).not.equals(null)
    expect(text()).includes('›')
  })

  it('holds the scan row while the roster loads, and shows a roster error', async function () {
    await mount({ rosterLoading: true })
    expect(text()).includes('Loading the team roster…')
    await click('Scan QR code to import lineup')
    expect(text()).includes('Share/Import Lineup')
    await act(async () => {
      root?.unmount()
    })
    document.body.innerHTML = ''
    await mount({ rosterError: 'Unable to load the roster.' })
    expect(text()).includes('Unable to load the roster.')
    await click('Scan QR code to import lineup')
    expect(camera.props).equals(undefined)
  })

  it('shows the side’s lineup as a QR code', async function () {
    const draft = session()
    await mount({ draft, side: 'home' })
    expect(text()).includes('Hawks')
    await click('Generate QR to share lineup')
    expect(text()).includes('Share Lineup')
    const svg = document.querySelector('svg[data-testid="qrCode"]')!
    expect(svg.getAttribute('aria-label')).equals('Lineup QR code')
    expect(svg.querySelector('path')!.getAttribute('d')).equals(
      qrMatrix(encodeLineupQr(lineupQrOf(draft, 'home'))).path
    )
  })

  it('sizes the QR to fit the window both ways, up to 320pt', function () {
    expect(shareQrSize(390, 844)).equals(310)
    expect(shareQrSize(1024, 1366)).equals(320)
    expect(shareQrSize(844, 390)).equals(150)
    expect(shareQrSize(900, 420)).equals(180)
    expect(shareQrSize(0, 0)).equals(120)
  })

  it('says the web cannot scan', async function () {
    await mount({ scannerSupported: false })
    await click('Scan QR code to import lineup')
    expect(text()).includes(
      'Unsupported on the web version of TeamStation. Please download the app.'
    )
    expect(text()).includes('Import Lineup')
    expect(camera.props).equals(undefined)
  })

  it('closes every step with Cancel or the backdrop', async function () {
    for (const step of [
      undefined,
      'Generate QR to share lineup',
      'Scan QR code to import lineup'
    ]) {
      const { closes } = await mount()
      if (step != null) await click(step)
      await click('Cancel')
      expect(closes, String(step)).deep.equals([1])
      await act(async () => {
        root?.unmount()
      })
      document.body.innerHTML = ''
    }
    const { closes } = await mount()
    await click('Dismiss sheet')
    expect(closes).deep.equals([1])
  })

  it('imports a code the camera reads, once', async function () {
    const { imports } = await mount()
    await click('Scan QR code to import lineup')
    expect(text()).includes('Import Lineup')
    expect(node('Camera starting')).not.equals(null)
    expect(camera.props!.active).equals(true)
    await report(props => {
      props.onStatus('ready')
    })
    expect(node('Camera ready')).not.equals(null)
    expect(node('QR payload')).equals(null)
    await report(props => {
      props.onCode(lineupQrFixture4.text)
      props.onCode(lineupQrFixture4.text)
    })
    expect(imports).has.length(1)
    expect(imports[0].added).has.length(12)
    const team = imports[0].draft.liveData.boxscore.teams.away
    expect(team.battingOrder).has.length(11)
  })

  it('warns in the yellow sheet for each code it cannot read, and scans again', async function () {
    const { imports } = await mount()
    await click('Scan QR code to import lineup')
    const cases: Array<[string, string]> = [
      ['hello', 'That QR code is not a GameChanger lineup.'],
      [
        encodeLineupQr({ e: 'e', t: 't', h: [], n: [] }),
        'That lineup QR code has no players.'
      ],
      [
        // A lineup whose only player has no name.
        encodeLineupQr({
          e: 'e',
          t: 't',
          h: [{ i: 'i', f: '', l: '', n: '1', p: 4 }],
          n: []
        }),
        'That lineup QR code could not be read.'
      ]
    ]
    for (const [code, message] of cases) {
      await report(props => {
        props.onCode(code)
      })
      expect(
        document.querySelector('[data-testid="warningSheet"]'),
        message
      ).not.equals(null)
      expect(text()).includes(message)
      expect(camera.props!.active).equals(false)
      // A code while the warning is up is not read.
      await report(props => {
        props.onCode(lineupQrFixture4.text)
      })
      expect(imports).has.length(0)
      await clickText('Scan Again')
      expect(document.querySelector('[data-testid="warningSheet"]')).equals(
        null
      )
      expect(camera.props!.active).equals(true)
    }
    await report(props => {
      props.onCode('hello')
    })
    await click('Close warning')
    expect(document.querySelector('[data-testid="warningSheet"]')).equals(null)
  })

  it('warns when the server cannot make the scanned players, and makes none twice on Scan Again', async function () {
    const made: string[] = []
    let fail = true
    const { imports } = await mount({
      onCreateGuest: async (side, player) => {
        if (fail && made.length === 3) throw new Error('offline')
        made.push(player.firstName)
        return await createGuest(side, player)
      }
    })
    await click('Scan QR code to import lineup')
    await report(props => {
      props.onCode(lineupQrFixture4.text)
    })
    expect(imports).has.length(0)
    expect(text()).includes(
      'The scanned players could not be added. Check the connection and scan again.'
    )
    expect(made).has.length(3)
    fail = false
    await clickText('Scan Again')
    await report(props => {
      props.onCode(lineupQrFixture4.text)
    })
    expect(imports).has.length(1)
    expect(imports[0].added).has.length(12)
    expect(made).has.length(12)
  })

  it('warns when there is no way to make the scanned players', async function () {
    const { imports } = await mount({ onCreateGuest: undefined })
    await click('Scan QR code to import lineup')
    await report(props => {
      props.onCode(lineupQrFixture4.text)
    })
    expect(imports).has.length(0)
    expect(text()).includes('The scanned players could not be added.')
  })

  it('treats a failure to place a read lineup as unreadable', async function () {
    const draft = session()
    // A side with no team to put players on fails as it is applied.
    ;(draft.liveData.boxscore.teams as Record<string, unknown>).away = undefined
    const { imports } = await mount({ draft })
    await click('Scan QR code to import lineup')
    await report(props => {
      props.onCode(lineupQrFixture4.text)
    })
    expect(imports).has.length(0)
    expect(text()).includes('That lineup QR code could not be read.')
  })

  it('offers the payload field with no camera, and injects through it', async function () {
    const { imports } = await mount()
    await click('Scan QR code to import lineup')
    expect(node('QR payload')).equals(null)
    await report(props => {
      props.onStatus('unavailable')
    })
    expect(node('Camera unavailable')).not.equals(null)
    expect(text()).includes('The camera is not available.')
    expect(node('QR payload')).not.equals(null)
    await type('QR payload', lineupQrFixture4.text)
    await click('Inject')
    expect(imports).has.length(1)
  })

  it('does not load a lineup the roster rules refuse once the game has begun', async function () {
    const begun = after(scoringSession(gameFixture), {
      type: 'pitch',
      call: 'B'
    })
    const { imports } = await mount({ draft: begun, game: begun })
    await click('Scan QR code to import lineup')
    await report(props => {
      props.onCode(lineupQrFixture4.text)
    })
    expect(imports).has.length(0)
    expect(text()).includes(
      'That lineup cannot be loaded now: Put only one man'
    )
    await clickText('Scan Again')
    // Before the game, the same code loads.
    await act(async () => {
      root?.unmount()
    })
    document.body.innerHTML = ''
    const fresh = scoringSession(gameFixture)
    const loaded = await mount({ draft: fresh, game: fresh })
    await click('Scan QR code to import lineup')
    await report(props => {
      props.onCode(lineupQrFixture4.text)
    })
    expect(loaded.imports).has.length(1)
  })

  it('loads a reordered lineup while a next batter is still to be chosen', async function () {
    // As the engine's own test: the whole order walks, the order changes, and
    // the batter due is then on base.
    let awaiting = scoringGame()
    for (let i = 0; i < 3; i++) awaiting = walk(awaiting)
    awaiting = strikeout(
      after(awaiting, {
        type: 'lineup',
        kind: 'battingOrder',
        side: 'away',
        order: [4, 1, 2, 3, 5, 6, 7, 8, 9]
      })
    )
    expect(awaiting.awaitingBatter).not.equals(null)
    const exported = lineupQrOf(awaiting, 'away')
    const reordered = encodeLineupQr({
      ...exported,
      h: [...exported.h].reverse()
    })
    const { imports } = await mount({ draft: awaiting, game: awaiting })
    await click('Scan QR code to import lineup')
    await report(props => {
      props.onCode(reordered)
    })
    expect(text()).not.includes('That lineup cannot be loaded now')
    expect(imports).has.length(1)
    expect(imports[0].added).deep.equals([])
  })

  it('offers the payload field in a development build while the camera works', async function () {
    await mount({ devBuild: true })
    await click('Scan QR code to import lineup')
    await report(props => {
      props.onStatus('ready')
    })
    expect(node('QR payload')).not.equals(null)
    expect(all('Inject')).has.length(1)
  })

  it('reads a native status, and has the web scan with no camera', function () {
    expect(qrScannerStatusOf('ready')).equals('ready')
    expect(qrScannerStatusOf('denied')).equals('denied')
    expect(qrScannerStatusOf('available')).equals('unavailable')
    expect(qrScannerStatusOf('')).equals('unavailable')
    expect(qrScannerSupported).equals(false)
    expect(
      QrScanner({
        active: true,
        onCode: () => undefined,
        onStatus: () => undefined
      })
    ).equals(null)
  })

  it('says when the camera may not be used', async function () {
    await mount()
    await click('Scan QR code to import lineup')
    await report(props => {
      props.onStatus('denied')
    })
    expect(node('Camera denied')).not.equals(null)
    expect(text()).includes(
      'TeamStation needs the camera to scan a lineup. Allow it in Settings.'
    )
  })
})
