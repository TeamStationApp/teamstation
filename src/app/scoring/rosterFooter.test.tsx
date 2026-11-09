import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { scoringSession } from '../../test/scoringSession'
import { fittedTextScale } from '../components/fittedText'
import { getTheme, ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { lineupQrFixture4 } from './lineupQr.fixtures'
import { encodeLineupQr } from './lineupQrCodec'
import { createGuest } from './lineupShareSheet.test'
import type { QrScannerProps } from './qrScannerProps'
import {
  ROSTER_MODE_LABELS,
  ROSTER_SAVE_FIT,
  RosterEditor,
  rosterFooterDrop,
  rosterFooterGap,
  rosterFooterSizes,
  rosterModes,
  rosterPillModes
} from './RosterEditor'
import { copyState, initialScoringState } from './scoringMachine'
import { ScoringSheetHeight } from './ScoringSheet'
import type { ScoringSessionState } from './scoringTypes'

let root: Root | undefined
let host: HTMLDivElement
const render = async (
  element: React.ReactElement,
  sheetHeight?: number
): Promise<void> => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        {sheetHeight == null ? (
          element
        ) : (
          <ScoringSheetHeight.Provider value={sheetHeight}>
            {element}
          </ScoringSheetHeight.Provider>
        )}
      </ThemeProvider>
    )
  })
}
const node = (label: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const click = async (label: string): Promise<void> => {
  const found = node(label)
  expect(found, label).not.equals(null)
  await act(async () => {
    found!.click()
  })
}
const tabs = (): string[] =>
  [...host.querySelectorAll('[role="tab"]')].map(
    tab => tab.getAttribute('aria-label') ?? ''
  )
const testId = (id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const fresh = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(scoringSession(gameFixture))
/** The rgb() a browser computes for a #rrggbb colour. */
const rgb = (hex: string): string =>
  `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`

describe('roster screen bottom bar and slider', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
  })
  it('labels the tabs Roster, Lineup and Defense, with a Box Score pill first and Plan last for a coach', async function () {
    expect(rosterModes('scorekeeper')).deep.equals([
      'editRoster',
      'lineup',
      'defense'
    ])
    expect(rosterModes('coach')).deep.equals([
      'boxScore',
      'editRoster',
      'lineup',
      'defense',
      'plan'
    ])
    // The box score is a pill of its own, not one of the tabs.
    expect(rosterPillModes('scorekeeper')).deep.equals(
      rosterModes('scorekeeper')
    )
    expect(rosterPillModes('coach')).deep.equals([
      'editRoster',
      'lineup',
      'defense',
      'plan'
    ])
    expect(ROSTER_MODE_LABELS).deep.equals({
      boxScore: 'Box Score',
      editRoster: 'Roster',
      lineup: 'Lineup',
      defense: 'Defense',
      plan: 'Plan'
    })
    await render(<RosterEditor state={fresh()} onSave={() => undefined} />)
    expect(tabs()).deep.equals([
      'Away Team',
      'Home Team',
      'Roster',
      'Lineup',
      'Defense'
    ])
    // The visible words are the accessible names.
    for (const label of ['Roster', 'Lineup', 'Defense'])
      expect(node(label)!.textContent).equals(label)
    // The roster first: who is on the team, and how to add somebody.
    expect(node('Roster')!.getAttribute('aria-selected')).equals('true')
    expect(testId('Box Score pill')).equals(null)
    await act(async () => {
      root!.unmount()
    })
    host.remove()
    await render(
      <RosterEditor
        state={fresh()}
        audience="coach"
        fixedSide="home"
        renderBoxScore={() => <Text>Line score</Text>}
        onSave={() => undefined}
      />
    )
    expect(tabs()).deep.equals([
      'Box Score',
      'Roster',
      'Lineup',
      'Defense',
      'Plan'
    ])
    expect(testId('Box Score pill')!.getAttribute('aria-label')).equals(
      'Box Score'
    )
  })

  it('ends the roster with Create Player and Add Existing Player rows, and Create Player opens the player sheet', async function () {
    await render(<RosterEditor state={fresh()} onSave={() => undefined} />)
    const add = node('Create Player')!
    expect(add.getAttribute('role')).equals('button')
    expect(add.textContent).includes('Create Player').and.includes('›')
    // Create Player wears the head and shoulders with a plus, Add Existing
    // Player the magnifying glass, each with only a chevron after it.
    expect(add.querySelector('[data-testid="addPersonGlyph"]')).not.equals(null)
    const existing = node('Add Existing Player')!
    expect(existing.textContent).equals('searchAdd Existing Player›')
    expect(existing.querySelector('[data-testid="addPersonGlyph"]')).equals(
      null
    )
    // Nothing opens it yet without a way to search.
    expect(existing.getAttribute('aria-disabled')).equals('true')
    // The two rows end the list, after the last player.
    const list = testId('Edit roster players')!
    const cards = [...list.querySelectorAll('[role="button"]')].map(
      card => card.getAttribute('aria-label') ?? ''
    )
    expect(cards.slice(-2)).deep.equals([
      'Create Player',
      'Add Existing Player'
    ])
    // The footer no longer carries a text action.
    expect(testId('Roster footer bar')!.textContent).not.includes(
      'Create Player'
    )
    const field = (): Element | null =>
      document.querySelector('[aria-label="First Name"]')
    expect(field()).equals(null)
    await click('Create Player')
    expect(field()).not.equals(null)
    const close = [
      ...document.querySelectorAll<HTMLElement>('[aria-label="Cancel"]')
    ].at(-1)!
    await act(async () => {
      close.click()
    })
    expect(field()).equals(null)
  })

  it('hides the microphone when the server does not dictate', async function () {
    await render(<RosterEditor state={fresh()} onSave={() => undefined} />)
    expect(testId('Roster mic')).equals(null)
    // Cancel's half, where the microphone sits beside it, and Save Rosters.
    const bar = testId('Roster footer bar')!
    expect(bar.children).length(2)
    expect(bar.textContent).equals('CancelSave Rosters')
  })

  it('centres a round microphone, twelve points taller than Save Rosters', async function () {
    expect(rosterFooterSizes(false, false)).deep.equals({ save: 36, mic: 48 })
    expect(rosterFooterSizes(true, false)).deep.equals({ save: 36, mic: 48 })
    expect(rosterFooterSizes(true, true)).deep.equals({ save: 28, mic: 40 })
    await render(
      <RosterEditor
        state={fresh()}
        dictationAvailable
        onSave={() => undefined}
      />
    )
    const bar = testId('Roster footer bar')!
    const [left, mic, right] = [...bar.children] as HTMLElement[]
    expect(mic.getAttribute('data-testid')).equals('Roster mic')
    expect(left.style.flexGrow).equals('1')
    expect(right.style.flexGrow).equals('1')
    expect(bar.style.alignItems).equals('center')
    expect(node('Save Rosters')!.style.minHeight).equals('36px')
    expect(mic.style.width).equals('48px')
    expect(mic.style.height).equals('48px')
    expect(mic.style.borderTopLeftRadius).equals('24px')
    expect(mic.querySelector('[aria-label]')).equals(null)
    await act(async () => {
      root!.unmount()
    })
    host.remove()
    // A short sheet shrinks the Defense tab's Save, and the microphone with it.
    await render(
      <RosterEditor
        state={fresh()}
        dictationAvailable
        onSave={() => undefined}
      />,
      260
    )
    await click('Defense')
    expect(node('Save Rosters')!.style.minHeight).equals('28px')
    expect(testId('Roster mic')!.style.width).equals('40px')
  })

  it('shrinks Save Rosters’ and Cancel’s labels together to fit a narrow bar whole, down to three quarters of their size, and keeps their height', async function () {
    // Its 87 points in 72 of room on a 320-point screen.
    expect(fittedTextScale(87, 72, ROSTER_SAVE_FIT)).equals(0.81)
    expect(fittedTextScale(87, 87, ROSTER_SAVE_FIT)).equals(1)
    expect(fittedTextScale(87, 200, ROSTER_SAVE_FIT)).equals(1)
    expect(fittedTextScale(87, 40, ROSTER_SAVE_FIT)).equals(0.75)
    // Nothing measured yet: full size.
    expect(fittedTextScale(0, 72, ROSTER_SAVE_FIT)).equals(1)
    expect(fittedTextScale(87, 0, ROSTER_SAVE_FIT)).equals(1)
    for (const audience of ['scorekeeper', 'coach'] as const) {
      await render(
        <RosterEditor
          state={fresh()}
          audience={audience}
          {...(audience === 'coach' ? { fixedSide: 'away' as const } : {})}
          dictationAvailable
          onSave={() => undefined}
        />
      )
      const labelOf = (name: string): HTMLElement =>
        node(name)!.querySelector<HTMLElement>('[dir="auto"]')!
      const sizes = (): number[] =>
        ['Cancel', 'Save Rosters'].map(name =>
          parseFloat(getComputedStyle(labelOf(name)).fontSize)
        )
      expect(sizes()).deep.equals([14, 14])
      // The test page has no layout: the widths a browser reads.
      const lay = async (testID: string, width: number): Promise<void> => {
        await act(async () => {
          ;(
            host.querySelector(`[data-testid="${testID}"]`) as unknown as {
              __reactLayoutHandler: (event: unknown) => void
            }
          ).__reactLayoutHandler({
            nativeEvent: { layout: { x: 0, y: 0, width, height: 36 } }
          })
        })
      }
      // Save Rosters' 87 points and Cancel's 48, at full size, in a 108-
      // point box: 72 of room inside the pill's padding. Both shrink alike.
      await lay('Roster footer label 0', 48)
      await lay('Roster footer label 1', 87)
      await lay('Roster cancel box', 108)
      for (const size of sizes()) expect(size).closeTo(14 * 0.81, 0.001)
      expect(node('Save Rosters')!.style.minHeight).equals('36px')
      expect(node('Cancel')!.style.minHeight).equals('36px')
      // A wider bar again: full size.
      await lay('Roster cancel box', 200)
      expect(sizes()).deep.equals([14, 14])
      // Never below three quarters.
      await lay('Roster cancel box', 60)
      for (const size of sizes()) expect(size).closeTo(14 * 0.75, 0.001)
      // The full-size copies are hidden from screen readers.
      const copy = host.querySelector('[data-testid="Roster footer label 0"]')!
      expect(copy.closest('[aria-hidden="true"]')).not.equals(null)
      await act(async () => {
        root!.unmount()
      })
      host.remove()
    }
  })

  for (const audience of ['scorekeeper', 'coach'] as const)
    it(`puts the ${audience}’s Cancel, a red button as large as Save Rosters, left of the microphone`, async function () {
      const cancels: number[] = []
      const reloads: number[] = []
      await render(
        <RosterEditor
          state={fresh()}
          audience={audience}
          {...(audience === 'coach' ? { fixedSide: 'away' as const } : {})}
          dictationAvailable
          onCancel={() => cancels.push(1)}
          onReload={() => reloads.push(1)}
          onSave={() => undefined}
        />
      )
      const bar = testId('Roster footer bar')!
      const cancel = testId('Roster cancel')!
      expect(cancel).equals(node('Cancel'))
      expect(bar.contains(cancel)).equals(true)
      const mic = testId('Roster mic')!
      expect(
        cancel.compareDocumentPosition(mic) & Node.DOCUMENT_POSITION_FOLLOWING
      ).not.equals(0)
      expect(
        mic.compareDocumentPosition(node('Save Rosters')!) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).not.equals(0)
      // A red button with white words, the same shell as Save Rosters, and
      // as wide: each fills its half of the bar.
      const save = node('Save Rosters')!
      expect(cancel.getAttribute('role')).equals('button')
      expect(getComputedStyle(cancel).backgroundColor).equals(
        rgb(getTheme().scoringOutColor)
      )
      expect(getComputedStyle(cancel.firstElementChild!).color).equals(
        rgb('#ffffff')
      )
      expect(getComputedStyle(save.firstElementChild!).color).equals(
        rgb('#ffffff')
      )
      for (const property of [
        'height',
        'minHeight',
        'borderTopLeftRadius'
      ] as const)
        expect(cancel.style[property], property).equals(save.style[property])
      for (const property of ['fontFamily', 'fontSize', 'fontWeight'] as const)
        expect(
          getComputedStyle(cancel.firstElementChild!)[property],
          property
        ).equals(getComputedStyle(save.firstElementChild!)[property])
      expect(cancel.style.height).equals('36px')
      const [left, , right] = [...bar.children] as HTMLElement[]
      expect(left.contains(cancel)).equals(true)
      expect(right.contains(save)).equals(true)
      expect(left.style.flexGrow).equals('1')
      expect(right.style.flexGrow).equals('1')
      // Nothing is left below the bar.
      const footer = testId('Roster footer')!
      expect(footer.lastElementChild).equals(bar)
      await click('Cancel')
      expect(audience === 'coach' ? reloads : cancels).deep.equals([1])
      expect(audience === 'coach' ? cancels : reloads).deep.equals([])
    })

  it('lowers the bar ten points into the bottom safe area, or the whole of a smaller one, and keeps the scorekeeper’s bar off a bare bottom edge', async function () {
    expect(rosterFooterDrop({ bottom: 34 })).equals(10)
    expect(rosterFooterDrop({ bottom: 6 })).equals(6)
    expect(rosterFooterDrop({ bottom: 0 })).equals(0)
    expect(rosterFooterGap({ bottom: 0 }, 'scorekeeper')).equals(8)
    expect(rosterFooterGap({ bottom: 34 }, 'scorekeeper')).equals(0)
    expect(rosterFooterGap({ bottom: 0 }, 'coach')).equals(0)
    await render(
      <RosterEditor state={fresh()} bottomInset={34} onSave={() => undefined} />
    )
    expect(testId('Roster footer bar')!.style.marginBottom).equals('-10px')
    await act(async () => {
      root!.unmount()
    })
    host.remove()
    // A browser has no inset: nothing moves.
    await render(<RosterEditor state={fresh()} onSave={() => undefined} />)
    const margin = testId('Roster footer bar')!.style.marginBottom
    expect(margin === '' ? 0 : Number.parseFloat(margin)).equals(0)
  })

  it('draws dictation’s own control in the microphone’s place, and its chat over the top of the screen', async function () {
    await render(
      <RosterEditor
        state={fresh()}
        dictation={{
          control: <Text accessibilityLabel="Round control">mic</Text>,
          chat: <Text accessibilityLabel="Roster chat">said</Text>
        }}
        onSave={() => undefined}
      />
    )
    const mic = testId('Roster mic')!
    expect(mic.style.width).equals('48px')
    expect(mic.querySelector('[aria-label="Round control"]')).not.equals(null)
    // An overlay at the top, above the footer: it takes no room of its own.
    const chat = node('Roster chat')!
    const overlay = testId('Roster chat overlay')!
    expect(overlay.contains(chat)).equals(true)
    expect(overlay.style.position).equals('absolute')
    expect(overlay.style.top).equals('0px')
    expect(overlay.contains(testId('Roster editor top'))).equals(false)
    expect(overlay.contains(testId('Roster footer'))).equals(false)
    const footer = testId('Roster footer') as unknown as {
      __reactLayoutHandler: (event: unknown) => void
    }
    await act(async () => {
      footer.__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 60 } }
      })
    })
    // Clear of the footer and the gap above it.
    expect(testId('Roster chat overlay')!.style.bottom).equals('68px')
  })

  it('lights Save Rosters only while the draft differs from the game', async function () {
    const state = fresh()
    const order = state.session.liveData.boxscore.teams.away.battingOrder
    const last = state.session.gameData.players[order.at(-1)!].fullName
    const first = state.session.gameData.players[order[0]].fullName
    let saved = 0
    await render(
      <RosterEditor
        state={state}
        defaultSide="away"
        onSave={() => {
          saved++
        }}
      />
    )
    const disabled = (): string | null =>
      node('Save Rosters')!.getAttribute('aria-disabled')
    expect(disabled()).equals('true')
    // Taking the last batter out changes the lineup; putting him back at the
    // end restores it, by hand, and Save dims again.
    await click(`Remove ${last}`)
    expect(disabled()).equals(null)
    await click(`Add ${last} to Lineup`)
    expect(disabled()).equals('true')
    await click('Save Rosters')
    expect(saved).equals(0)
    // The first batter put back at the end is a new order.
    await click(`Remove ${first}`)
    await click(`Add ${first} to Lineup`)
    expect(disabled()).equals(null)
    await click('Save Rosters')
    expect(saved).equals(1)
  })

  it('lights Save Rosters with no change while the lineup is not yet accepted, and saves it as it stands', async function () {
    const state = fresh()
    const order = state.session.liveData.boxscore.teams.away.battingOrder
    const last = state.session.gameData.players[order.at(-1)!].fullName
    const saved: number[][] = []
    await render(
      <RosterEditor
        state={state}
        defaultSide="away"
        unaccepted
        onSave={draft => {
          saved.push([...draft.liveData.boxscore.teams.away.battingOrder])
        }}
      />
    )
    const disabled = (): string | null =>
      node('Save Rosters')!.getAttribute('aria-disabled')
    expect(disabled()).equals(null)
    // A change made and undone by hand leaves it lit.
    await click(`Remove ${last}`)
    await click(`Add ${last} to Lineup`)
    expect(disabled()).equals(null)
    await click('Save Rosters')
    expect(saved).deep.equals([order])
  })

  it('keeps Save Rosters dim for a lineup not yet accepted that does not validate', async function () {
    const state = fresh()
    const defense = state.session.liveData.boxscore.teams.away.defense
    // A saved duplicate can come from a merge; an opposing defender is invalid.
    defense.C = state.session.liveData.boxscore.teams.home.defense.P
    await render(
      <RosterEditor
        state={state}
        defaultSide="away"
        unaccepted
        onSave={() => undefined}
      />
    )
    expect(node('Save Rosters')!.getAttribute('aria-disabled')).equals('true')
  })
  it('accepts retained defensive placements that share a merged identity', async function () {
    const state = fresh()
    const defense = state.session.liveData.boxscore.teams.away.defense
    defense.C = defense.P
    let saved = false
    await render(
      <RosterEditor
        state={state}
        defaultSide="away"
        unaccepted
        onSave={() => {
          saved = true
        }}
      />
    )
    expect(node('Save Rosters')!.getAttribute('aria-disabled')).equals(null)
    await click('Save Rosters')
    expect(saved).equals(true)
  })
})

/** A camera the test drives, as Share Lineup's scan step sees one. */
const camera: { props?: QrScannerProps } = {}
function FakeScanner(props: QrScannerProps): null {
  camera.props = props
  return null
}
const scanner = { component: FakeScanner, supported: true, devBuild: false }
const SHARE = 'Share or import team lineup'
/** The Roster tab's share row, which opens Share Lineup. */
const openShare = async (): Promise<void> => {
  await click('Roster')
  await click(SHARE)
}
/** A control in an open sheet, which renders outside the editor's host. */
const tap = async (label: string): Promise<void> => {
  const found = [
    ...document.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)
  ].at(-1)
  expect(found, label).not.equals(undefined)
  await act(async () => {
    found!.click()
  })
}

describe('roster screen Share Lineup', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    camera.props = undefined
    document.body.innerHTML = ''
  })

  it('leads the Roster tab with a share row styled as a player row', async function () {
    await render(<RosterEditor state={fresh()} onSave={() => undefined} />)
    await click('Roster')
    const list = testId('Edit roster players')!
    const cards = list.querySelectorAll<HTMLElement>('[role="button"]')
    expect(cards[0].getAttribute('aria-label')).equals(SHARE)
    // One bold title, then the chevron.
    // A hidden copy measures the title, which the line shown follows.
    expect(cards[0].textContent).equals(`${SHARE}${SHARE}›`)
    const title = testId('Share lineup title')!
    const line = [...title.querySelectorAll<HTMLElement>('[dir="auto"]')].at(
      -1
    )!
    expect(line.textContent).equals(SHARE)
    expect(getComputedStyle(line).fontWeight).equals('700')
    // The same box as a jersey's, with the QR in the jersey number's mint.
    const box = testId('Share lineup badge')!
    const jersey = list.querySelector<HTMLElement>(
      '[data-testid^="Jersey badge"]'
    )!
    for (const property of [
      'width',
      'height',
      'backgroundColor',
      'borderColor',
      'borderRadius'
    ] as const)
      expect(getComputedStyle(box)[property], property).equals(
        getComputedStyle(jersey)[property]
      )
    const mint = getComputedStyle(jersey.firstElementChild!).color
    const glyph = box.querySelector<SVGElement>(
      '[data-testid="lineupQrGlyph-qr"]'
    )!
    expect(rgb(glyph.querySelector('path')!.getAttribute('stroke')!)).equals(
      mint
    )
    // As wide as the badge's inside, so its squares leave half the margin.
    expect(glyph.getAttribute('width')).equals('54')
    // Share Lineup has left the footer: Cancel and Save Rosters, on one row.
    const footer = testId('Roster footer')!
    expect(footer.textContent).equals('CancelSave Rosters')
    expect(testId('Roster footer actions')).equals(null)
  })

  it('shares his own lineup and scans only the opponent’s', async function () {
    await render(
      <RosterEditor
        state={fresh()}
        defaultSide="away"
        scorekeeperSide="away"
        lineupScanner={scanner}
        onSave={() => undefined}
      />
    )
    await click('Roster')
    expect(node('Share Team Lineup')).not.equals(null)
    expect(node('Scan to Import Team Lineup')).equals(null)
    expect(node('Share or import team lineup')).equals(null)
    expect(node('Game roster information')).equals(null)
    expect(host.textContent).includes('Tap player to edit.')
    expect(
      testId('Share lineup badge')!.querySelector(
        '[data-testid="lineupQrGlyph-qr"]'
      )
    ).not.equals(null)
    await click('Share Team Lineup')
    expect(document.body.textContent).includes('Share Lineup')
    expect(document.body.textContent).not.includes('Share/Import Lineup')
    expect(
      document.querySelector('[aria-label="Generate QR to share lineup"]')
    ).equals(null)
    expect(
      document.querySelector('[aria-label="Scan QR code to import lineup"]')
    ).equals(null)
    expect(document.querySelector('svg[data-testid="qrCode"]')).not.equals(null)
    await tap('Cancel')
    await click('Home Team')
    expect(node('Scan to Import Team Lineup')).not.equals(null)
    expect(node('Share Team Lineup')).equals(null)
    expect(
      testId('Share lineup badge')!.querySelector(
        '[data-testid="lineupQrGlyph-scan"]'
      )
    ).not.equals(null)
    await click('Scan to Import Team Lineup')
    expect(document.body.textContent).includes('Import Lineup')
    expect(document.body.textContent).not.includes('Share/Import Lineup')
    expect(
      document.querySelector('[aria-label="Generate QR to share lineup"]')
    ).equals(null)
    expect(document.querySelector('svg[data-testid="qrCode"]')).equals(null)
    expect(camera.props).not.equals(undefined)
  })

  it('opens the chooser for the team on the slider', async function () {
    await render(<RosterEditor state={fresh()} onSave={() => undefined} />)
    await openShare()
    expect(document.body.textContent).includes('Share/Import Lineup')
    expect(document.body.textContent).includes('Owls')
    await tap('Cancel')
    expect(document.body.textContent).not.includes('Share/Import Lineup')
    await click('Home Team')
    await openShare()
    const heading = document.querySelector('[role="heading"]')!
    expect(heading.textContent).equals('Hawks')
  })

  it('loads a scanned lineup as unsaved changes that Save Rosters keeps', async function () {
    const saves: ScoringSessionState[] = []
    const batters: Array<number | undefined> = []
    const state = fresh()
    await render(
      <RosterEditor
        state={state}
        // A next batter chosen before the scan, whom the import benches.
        initialDraft={{
          draft: state.session,
          side: 'away',
          mode: 'lineup',
          nextBatter: state.session.liveData.boxscore.teams.away.battingOrder[0]
        }}
        lineupScanner={scanner}
        onCreateGuest={createGuest}
        onSave={(draft, nextBatter) => {
          saves.push(draft)
          batters.push(nextBatter)
        }}
      />
    )
    await openShare()
    await tap('Scan QR code to import lineup')
    await act(async () => {
      camera.props!.onCode(lineupQrFixture4.text)
    })
    expect(document.body.textContent).not.includes('Import Lineup')
    const note = 'Imported 12 players · 9 benched'
    expect(host.textContent).includes(note)
    expect(node('Save Rosters')!.getAttribute('aria-disabled')).equals(null)
    // The next change clears the line.
    await click('Remove Corey Seager')
    expect(host.textContent).not.includes(note)
    await click('Save Rosters')
    expect(saves).has.length(1)
    const team = saves[0].liveData.boxscore.teams.away
    expect(team.battingOrder).has.length(10)
    expect(batters).deep.equals([undefined])
  })

  it('drops the line when the team switches, and Cancel closes without saving', async function () {
    const saves: ScoringSessionState[] = []
    const cancels: number[] = []
    await render(
      <RosterEditor
        state={fresh()}
        lineupScanner={{ ...scanner, devBuild: undefined }}
        onCreateGuest={createGuest}
        onCancel={() => cancels.push(1)}
        onSave={draft => {
          saves.push(draft)
        }}
      />
    )
    await openShare()
    await tap('Scan QR code to import lineup')
    await act(async () => {
      camera.props!.onCode(
        encodeLineupQr({
          ...lineupQrFixture4.lineup,
          h: lineupQrFixture4.lineup.h.slice(0, 1),
          n: []
        })
      )
    })
    expect(host.textContent).includes('Imported 1 player · 2 benched')
    await click('Home Team')
    expect(host.textContent).not.includes('Imported 1 player')
    // Back on the team it was for, the line stays gone.
    await click('Away Team')
    expect(host.textContent).not.includes('Imported 1 player')
    await click('Cancel')
    expect(cancels).deep.equals([1])
    expect(saves).deep.equals([])
  })

  it('puts a dense Defense tab’s problem on a line of its own above the footer bar', async function () {
    const state = fresh()
    // An edit that puts the pitcher behind the plate as well.
    const draft = copyState(state.session)
    const defense = draft.liveData.boxscore.teams.away.defense
    defense.C = defense.P
    // A wide window: react-native-web reads the document's size.
    const element = document.documentElement
    const width = Object.getOwnPropertyDescriptor(element, 'clientWidth')
    Object.defineProperty(element, 'clientWidth', {
      configurable: true,
      value: 900
    })
    window.dispatchEvent(new window.Event('resize'))
    try {
      await render(
        <RosterEditor
          state={state}
          dictationAvailable
          initialDraft={{ draft, side: 'away', mode: 'defense' }}
          onSave={() => undefined}
        />,
        400
      )
      const bar = testId('Roster footer bar')!
      const [half, mic, save] = [...bar.children] as HTMLElement[]
      // Cancel, the microphone and Save Rosters, and nothing else in the bar.
      expect(half.contains(node('Cancel'))).equals(true)
      expect(bar.querySelector('[role="alert"]')).equals(null)
      // The problem, just above the bar.
      const problem = testId('Roster footer problem')!
      expect(problem.getAttribute('role')).equals('alert')
      expect(problem.nextElementSibling).equals(bar)
      expect(problem.textContent).includes('invalid or duplicate defender')
      // One line, its whole text its name.
      expect(problem.getAttribute('aria-label')).equals(problem.textContent)
      expect(getComputedStyle(problem).whiteSpace).equals('nowrap')
      expect(getComputedStyle(problem).textOverflow).equals('ellipsis')
      expect(mic.getAttribute('data-testid')).equals('Roster mic')
      expect(save.contains(node('Save Rosters'))).equals(true)
      // It is not also drawn above the bar.
      expect(
        testId('Roster footer')!.querySelectorAll('[role="alert"]')
      ).has.length(1)
      expect(node('Share Lineup')).equals(null)
    } finally {
      if (width == null) Reflect.deleteProperty(element, 'clientWidth')
      else Object.defineProperty(element, 'clientWidth', width)
      window.dispatchEvent(new window.Event('resize'))
    }
  })

  it('offers the coach no share row', async function () {
    await render(
      <RosterEditor
        state={fresh()}
        audience="coach"
        fixedSide="away"
        onSave={() => undefined}
      />
    )
    await click('Roster')
    expect(node(SHARE)).equals(null)
    expect(node('Cancel')).not.equals(null)
  })
})
