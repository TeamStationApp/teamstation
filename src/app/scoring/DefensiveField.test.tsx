import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { scoringSession } from '../../test/scoringSession'
import { changeTheme, getTheme, ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import {
  CARD_TOP_OFFSET,
  DEFENSE_CONTROL_HEIGHT,
  DEFENSE_CONTROL_INSET,
  DEFENSE_LOCATIONS,
  defenseControlsPlacement,
  DefensiveField,
  FIELD_NAME_SCALE,
  fieldCardMetrics,
  fieldRows,
  SINGLE_LINE_FIT
} from './DefensiveField'
import { DefensiveFieldArt as NativeDefensiveFieldArt } from './DefensiveFieldArt.native'
import { gameFixture } from './isUnscoredGame.test'
import { RosterDragGroup } from './RosterDrag'
import { defenseRosterMinimum, RosterEditor } from './RosterEditor'
import { ROSTER_CARD_GAP, rosterGridColumns } from './rosterLayout'
import { initialScoringState } from './scoringMachine'
import { ScoringSheetHeight } from './ScoringSheet'
import { POSITIONS } from './scoringTypes'

describe('compact defensive field', function () {
  /** Every viewport height the field can take on a sheet, 60 up to 400. */
  const viewports = Array.from({ length: 35 }, (_, index) => 60 + index * 10)

  it('lays the positions out on six rows at every viewport height, none of three', function () {
    for (const viewport of viewports) {
      const { cardHeight } = fieldCardMetrics(viewport, false)
      const rows = fieldRows(DEFENSE_LOCATIONS, (cardHeight / viewport) * 100)
      expect(rows, `viewport ${viewport}`).deep.equals([
        ['CF'],
        ['LF', 'RF'],
        ['SS', '2B'],
        ['3B', '1B'],
        ['P'],
        ['C']
      ])
      expect(Math.max(...rows.map(row => row.length))).lessThan(3)
    }
    // Cards tall enough to meet join one row, top to bottom.
    expect(fieldRows(DEFENSE_LOCATIONS, 40)).deep.equals([
      ['CF', 'LF', 'RF', 'SS', '2B', '3B', '1B', 'P', 'C']
    ])
  })
  it('fits each card’s text inside the card from viewport 60 to 400', function () {
    for (const viewport of viewports)
      for (const compact of [false, true]) {
        const metrics = fieldCardMetrics(viewport, compact)
        expect(metrics.cardHeight).equals(Math.min(46, viewport * 0.14))
        expect(
          metrics.contentHeight,
          `viewport ${viewport}${compact ? ' compact' : ''}`
        ).at.most(metrics.cardHeight)
        expect(metrics.singleLine).equals(compact || metrics.cardHeight < 40)
        expect(metrics.positionOnly).equals(metrics.cardHeight < 21)
        if (!metrics.positionOnly)
          expect(metrics.lineHeight).equals(Math.round(metrics.fontSize * 1.2))
      }
    expect(fieldCardMetrics(0, false)).deep.equals({
      cardHeight: 46,
      singleLine: false,
      positionOnly: false,
      fontSize: 13.75,
      lineHeight: 17,
      contentHeight: 40
    })
    expect(fieldCardMetrics(200, false)).deep.includes({
      singleLine: true,
      fontSize: 12.5,
      lineHeight: 15,
      contentHeight: 21,
      fit: 0.75
    })
    // Only "P · Name" on one line shrinks to fit.
    expect(fieldCardMetrics(400, false).fit).equals(undefined)
    expect(fieldCardMetrics(140, false).fit).equals(undefined)
    // The smallest card the 60-point floor can squeeze to still holds its
    // position; below that the 5-point font is the floor.
    const smallest = fieldCardMetrics(50, false)
    expect(smallest.positionOnly).equals(true)
    expect(smallest.cardHeight).closeTo(7, 1e-9)
    expect(smallest.fontSize).closeTo(5, 1e-9)
    expect(smallest.contentHeight).closeTo(7, 1e-9)
    expect(fieldCardMetrics(20, false).fontSize).equals(5)
  })
  it('draws names 25% larger, and only the position on a field under 150 points', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const field = (compact: boolean): React.ReactElement => (
      <ThemeProvider>
        <RosterDragGroup>
          <DefensiveField
            compact={compact}
            defense={{ P: 1 }}
            display={() => '#7 Mookie Betts'}
            onPlace={() => undefined}
            onClear={() => undefined}
          />
        </RosterDragGroup>
      </ThemeProvider>
    )
    const lines = (): HTMLElement[] => [
      ...host
        .querySelector('[data-testid="Defense P card"]')!
        .querySelectorAll<HTMLElement>('[dir="auto"]')
    ]
    const layout = async (height: number): Promise<void> => {
      const node = host.querySelector(
        '[data-testid="Defensive field viewport"]'
      ) as unknown as { __reactLayoutHandler: (event: object) => void }
      await act(async () => {
        node.__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 0, width: 360, height } }
        })
      })
    }
    try {
      expect(FIELD_NAME_SCALE).equals(1.25)
      await act(async () => {
        root.render(field(false))
      })
      expect(
        host.querySelector<HTMLElement>(
          '[data-testid="Defensive field viewport"]'
        )!.style.flexBasis
      ).equals('330px')
      expect(lines().map(line => line.textContent)).deep.equals([
        'P',
        '#7 Mookie Betts'
      ])
      for (const line of lines()) {
        expect(line.style.fontSize).equals('13.75px')
        expect(line.style.lineHeight).equals('17px')
      }
      let placed = host.querySelector<HTMLElement>(
        '[data-testid="Defense CF card"]'
      )
      while (placed?.style.top === '') placed = placed.parentElement
      expect(placed!.style.top).equals('1%')
      await act(async () => {
        root.render(field(true))
      })
      expect(lines().map(line => line.textContent)).deep.equals([
        'P · #7 Mookie Betts'
      ])
      expect(lines()[0].style.fontSize).equals('12.5px')
      expect(lines()[0].style.lineHeight).equals('15px')
      await act(async () => {
        root.render(field(false))
      })
      await layout(140)
      const card = host.querySelector<HTMLElement>(
        '[data-testid="Defense P card"]'
      )!
      expect(card.style.height).equals('19.6px')
      expect(card.style.paddingTop).equals('0px')
      expect(lines().map(line => line.textContent)).deep.equals(['P'])
      expect(lines()[0].getAttribute('aria-label')).equals(
        'P · #7 Mookie Betts'
      )
      expect(lines()[0].style.fontSize).equals('17.6px')
      expect(host.querySelector('[aria-label="Assign C"]')!.textContent).equals(
        'C'
      )
      await layout(150)
      expect(lines().map(line => line.textContent)).deep.equals([
        'P · #7 Mookie Betts'
      ])
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('shrinks a one-line card to fit its card whole, down to three quarters of its size, and keeps it 25% larger when it fits', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const field = (name: string): React.ReactElement => (
      <ThemeProvider>
        <RosterDragGroup>
          <DefensiveField
            compact
            defense={{ P: 1 }}
            display={() => name}
            onPlace={() => undefined}
            onClear={() => undefined}
          />
        </RosterDragGroup>
      </ThemeProvider>
    )
    const line = (): HTMLElement =>
      host
        .querySelector('[data-testid="Defense P card"]')!
        .querySelector<HTMLElement>('[dir="auto"]')!
    const font = (): number => parseFloat(line().style.fontSize)
    // The test page has no layout: the browser's widths on a 320-point
    // screen, the card's 88 points of room and the line's drawn width.
    const lay = async (room: number, drawn: number): Promise<void> => {
      const box = line().parentElement!
      Object.defineProperty(box, 'clientWidth', {
        configurable: true,
        value: room
      })
      Object.defineProperty(line(), 'scrollWidth', {
        configurable: true,
        value: drawn
      })
      await act(async () => {
        ;(
          box as unknown as { __reactLayoutHandler: (event: unknown) => void }
        ).__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 0, width: room, height: 15 } }
        })
      })
    }
    try {
      expect(SINGLE_LINE_FIT).equals(0.75)
      await act(async () => {
        root.render(field('#7 Escobar'))
      })
      expect(line().textContent).equals('P · #7 Escobar')
      expect(font()).equals(12.5)
      // The line is drawn no wider than its content, nor than the card.
      expect(line().style.maxWidth).equals('100%')
      expect(line().style.width).equals('')
      await lay(88, 98)
      expect(font()).closeTo(12.5 * 0.88, 0.001)
      expect(line().style.lineHeight).equals('15px')
      // A card that fits it again: the full size, read from the shrunken width.
      await lay(120, 98 * 0.88)
      expect(font()).equals(12.5)
      // No narrower than three quarters: past that the name's end is cut.
      await lay(60, 98)
      expect(font()).closeTo(12.5 * 0.75, 0.001)
      // Another name is measured as it is drawn.
      Object.defineProperty(line(), 'scrollWidth', {
        configurable: true,
        value: 40
      })
      await act(async () => {
        root.render(field('#9 Ruth'))
      })
      expect(line().textContent).equals('P · #9 Ruth')
      expect(font()).equals(12.5)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('reserves a roster row when possible and yields to the complete field for wrapping errors', function () {
    expect(defenseRosterMinimum(0, true)).equals(64)
    expect(defenseRosterMinimum(0, false)).equals(88)
    expect(defenseRosterMinimum(128, true)).equals(64)
    expect(defenseRosterMinimum(111, true)).equals(49)
    expect(defenseRosterMinimum(80, false)).equals(12)
    expect(defenseRosterMinimum(40, true)).equals(0)
  })
  it('uses measured short sheet height to condense controls and retain list space', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <ScoringSheetHeight.Provider value={260}>
              <RosterEditor
                state={initialScoringState(scoringSession(gameFixture))}
                onSave={() => undefined}
              />
            </ScoringSheetHeight.Provider>
          </ThemeProvider>
        )
      })
      expect(
        host.querySelector<HTMLElement>('[data-testid="Roster editor top"]')!
          .style.maxHeight
      ).equals('48px')
      expect(
        host.querySelector('[data-testid="Roster selector captions"]')
      ).equals(null)
      expect(
        host.querySelector<HTMLElement>('[aria-label="Cancel"]')!.style
          .minHeight
      ).equals('36px')
      expect(host.querySelector('[aria-label="Batting lineup"]')).not.equals(
        null
      )
      await act(async () => {
        host.querySelector<HTMLElement>('[aria-label="Defense"]')!.click()
      })
      expect(
        host.querySelector<HTMLElement>('[data-testid="Roster editor top"]')!
          .style.maxHeight
      ).equals('28px')
      expect(
        host.querySelector<HTMLElement>('[aria-label="Cancel"]')!.style
          .minHeight
      ).equals('28px')
      await act(async () => {
        host.querySelector<HTMLElement>('[aria-label="Clear P"]')!.click()
      })
      expect(host.querySelector('[role="alert"]')).equals(null)
      expect(
        host
          .querySelector('[aria-label="Save Rosters"]')!
          .getAttribute('aria-disabled')
      ).not.equals('true')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('compacts defense before normal controls can starve the complete field', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const state = initialScoringState(scoringSession(gameFixture))
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <ScoringSheetHeight.Provider value={400}>
              <RosterEditor
                state={state}
                initialDraft={{
                  draft: state.session,
                  side: 'away',
                  mode: 'defense'
                }}
                onSave={() => undefined}
              />
            </ScoringSheetHeight.Provider>
          </ThemeProvider>
        )
      })
      expect(
        host.querySelector<HTMLElement>('[data-testid="Roster editor top"]')!
          .style.maxHeight
      ).equals('28px')
      expect(
        host.querySelector<HTMLElement>('[aria-label="Cancel"]')!.style
          .minHeight
      ).equals('28px')
      expect(host.querySelectorAll('[data-roster-target^="defense-"]')).length(
        9
      )
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('keeps every position in a fixed field and toggles assigned state colors', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let cleared = ''
    const originalTheme = getTheme()
    try {
      for (const theme of [tsBallpark, tsDark]) {
        await act(async () => {
          changeTheme(theme)
          root.render(
            <ThemeProvider>
              <RosterDragGroup>
                <DefensiveField
                  compact={theme === tsBallpark}
                  defense={{ P: 1 }}
                  display={() => '#7 Mookie Betts'}
                  onPlace={() => undefined}
                  onClear={position => {
                    cleared = position
                  }}
                />
                <NativeDefensiveFieldArt />
              </RosterDragGroup>
            </ThemeProvider>
          )
        })
        expect(host.querySelector('[aria-label="Defensive positions"]')).equals(
          null
        )
        expect(
          host.querySelector<HTMLElement>('[data-testid="Defensive field"]')!
            .style.height
        ).equals('')
        const pitcher = host.querySelector<HTMLElement>(
          '[data-testid="Defense P card"]'
        )!
        const catcher = host.querySelector<HTMLElement>(
          '[data-testid="Defense C card"]'
        )!
        expect(window.getComputedStyle(pitcher).borderStyle).equals('solid')
        expect(window.getComputedStyle(pitcher).borderColor).equals(
          'rgb(52, 211, 153)'
        )
        expect(window.getComputedStyle(pitcher).backgroundColor).equals(
          'rgb(29, 107, 66)'
        )
        expect(window.getComputedStyle(catcher).borderStyle).equals('dashed')
        expect(window.getComputedStyle(catcher).borderColor).equals(
          'rgba(153, 27, 27, 0.6)'
        )
        expect(window.getComputedStyle(catcher).backgroundColor).equals(
          'rgba(69, 10, 10, 0.8)'
        )
        expect(
          window.getComputedStyle(pitcher.querySelector('[dir="auto"]')!).color
        ).equals('rgb(255, 255, 255)')
        expect(
          window.getComputedStyle(catcher.querySelector('[dir="auto"]')!).color
        ).equals('rgb(252, 165, 165)')
        const fields = [...host.querySelectorAll('svg')]
        expect(fields).length(2)
        for (const field of fields) {
          expect(field.getAttribute('viewBox')).equals('0 0 360 240')
          expect(field.querySelector('path')!.getAttribute('fill')).equals(
            theme.scoringSurface.idle
          )
          expect(field.querySelectorAll('path')[1].getAttribute('fill')).equals(
            theme.scoringSurface.input
          )
        }
        expect(Object.keys(DEFENSE_LOCATIONS).sort()).deep.equals(
          [...POSITIONS].sort()
        )
        expect(
          host.querySelectorAll('[data-roster-target^="defense-"]')
        ).length(9)
      }
      await act(async () => {
        host.querySelector<HTMLElement>('[aria-label="Clear P"]')!.click()
      })
      await act(async () => {
        root.render(
          <ThemeProvider>
            <RosterDragGroup>
              <DefensiveField
                defense={{}}
                display={() => '#7 Mookie Betts'}
                onPlace={() => undefined}
                onClear={() => undefined}
              />
            </RosterDragGroup>
          </ThemeProvider>
        )
      })
      expect(
        window.getComputedStyle(
          host.querySelector<HTMLElement>('[data-testid="Defense P card"]')!
        ).borderTopStyle
      ).equals('dashed')
      expect(cleared).equals('P')
      expect(
        host.querySelector('[aria-label="Assign C"]')!.textContent
      ).includes('Unassigned')
    } finally {
      await act(async () => {
        root.unmount()
        changeTheme(originalTheme)
      })
      host.remove()
    }
  })
  it('makes each assigned card a drag source with no hold, and leaves an empty one a drop target only (U32)', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <RosterDragGroup>
              <DefensiveField
                defense={{ P: 1, C: null }}
                display={() => '#7 Mookie Betts'}
                onPlace={() => undefined}
                onClear={() => undefined}
              />
            </RosterDragGroup>
          </ThemeProvider>
        )
      })
      const pitcher = host.querySelector<HTMLElement>(
        '[data-roster-target="defense-P"]'
      )!
      const catcher = host.querySelector<HTMLElement>(
        '[data-roster-target="defense-C"]'
      )!
      expect(pitcher.getAttribute('data-roster-player')).equals('1')
      expect(pitcher.style.touchAction).equals('none')
      expect(catcher.getAttribute('data-roster-player')).equals(null)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('puts Help and Clear in the field’s top corners from 160 points, clear of every card', function () {
    expect(defenseControlsPlacement(160)).equals('corners')
    expect(defenseControlsPlacement(400)).equals('corners')
    expect(defenseControlsPlacement(159.5)).equals('row')
    expect(defenseControlsPlacement(60)).equals('row')
    // The widest a control's word draws, and the narrowest field (a
    // 320-point screen less its margins).
    const controlWidth = 60
    for (let height = 160; height <= 400; height += 5)
      for (const width of [288, 370, 600]) {
        const { cardHeight } = fieldCardMetrics(height, false)
        const controls = [
          {
            left: DEFENSE_CONTROL_INSET,
            right: DEFENSE_CONTROL_INSET + controlWidth
          },
          {
            left: width - DEFENSE_CONTROL_INSET - controlWidth,
            right: width - DEFENSE_CONTROL_INSET
          }
        ].map(box => ({
          ...box,
          top: DEFENSE_CONTROL_INSET,
          bottom: DEFENSE_CONTROL_INSET + DEFENSE_CONTROL_HEIGHT
        }))
        for (const position of POSITIONS) {
          const [x, y] = DEFENSE_LOCATIONS[position]
          const card = {
            left: ((x - 15) / 100) * width,
            right: ((x + 15) / 100) * width,
            top: ((y - CARD_TOP_OFFSET) / 100) * height,
            bottom: ((y - CARD_TOP_OFFSET) / 100) * height + cardHeight
          }
          for (const control of controls)
            expect(
              control.right <= card.left ||
                control.left >= card.right ||
                control.bottom <= card.top ||
                control.top >= card.bottom,
              `${position} at ${width}×${height}`
            ).equals(true)
        }
      }
  })
  it('draws Help and Clear on the field’s corners, or in a row above a field under 160 points, and Clear clears', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let cleared = 0
    let helped = 0
    const layout = async (height: number): Promise<void> => {
      const node = host.querySelector(
        '[data-testid="Defensive field viewport"]'
      ) as unknown as { __reactLayoutHandler: (event: object) => void }
      await act(async () => {
        node.__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 0, width: 360, height } }
        })
      })
    }
    const control = (label: string): HTMLElement =>
      host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
    const rgb = (hex: string): string => {
      const probe = document.createElement('div')
      probe.style.color = hex
      return probe.style.color
    }
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <RosterDragGroup>
              <DefensiveField
                defense={{ P: 1 }}
                display={() => '#7 Mookie Betts'}
                onPlace={() => undefined}
                onClear={() => undefined}
                onHelp={() => {
                  helped++
                }}
                onClearAll={() => {
                  cleared++
                }}
              />
            </RosterDragGroup>
          </ThemeProvider>
        )
      })
      const field = host.querySelector('[data-testid="Defensive field"]')!
      for (const height of [0, 330, 160]) {
        if (height > 0) await layout(height)
        const help = control('Defense help')
        const clear = control('Clear Defense')
        expect(field.contains(help), `${height}`).equals(true)
        expect(field.contains(clear)).equals(true)
        expect(help.style.position).equals('absolute')
        expect([help.style.top, help.style.left]).deep.equals(['4px', '4px'])
        expect(clear.style.position).equals('absolute')
        expect([clear.style.top, clear.style.right]).deep.equals(['4px', '4px'])
        expect(
          host.querySelector('[data-testid="Defense controls row"]')
        ).equals(null)
      }
      expect(
        getComputedStyle(control('Defense help').firstElementChild!).color
      ).equals(rgb(getTheme().linkTextColor))
      expect(
        getComputedStyle(control('Clear Defense').firstElementChild!).color
      ).equals(rgb(getTheme().scoringOutColor))
      await act(async () => {
        control('Clear Defense').click()
      })
      await act(async () => {
        control('Defense help').click()
      })
      expect([cleared, helped]).deep.equals([1, 1])
      // A squeezed field: a row of their own above it, Help on the left.
      await layout(120)
      const row = host.querySelector<HTMLElement>(
        '[data-testid="Defense controls row"]'
      )!
      expect(row.style.height).equals('24px')
      expect(row.style.justifyContent).equals('space-between')
      expect(field.contains(control('Clear Defense'))).equals(false)
      expect([...row.children]).deep.equals([
        control('Defense help'),
        control('Clear Defense')
      ])
      expect(control('Clear Defense').style.position).not.equals('absolute')
      expect(
        row.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING
      ).not.equals(0)
      await act(async () => {
        control('Clear Defense').click()
      })
      expect(cleared).equals(2)
      // Without them, neither is drawn.
      await act(async () => {
        root.render(
          <ThemeProvider>
            <RosterDragGroup>
              <DefensiveField
                defense={{}}
                display={() => ''}
                onPlace={() => undefined}
                onClear={() => undefined}
              />
            </RosterDragGroup>
          </ThemeProvider>
        )
      })
      expect(host.querySelector('[aria-label="Clear Defense"]')).equals(null)
      expect(host.querySelector('[aria-label="Defense help"]')).equals(null)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('runs the Defense roster’s two columns from margin to margin', function () {
    expect(rosterGridColumns(370, 0, ROSTER_CARD_GAP)).deep.equals([
      { left: 0, width: 177 },
      { left: 193, width: 177 }
    ])
    for (const [width, margin] of [
      [288, 0],
      [370, 8],
      [600, 16]
    ]) {
      const [left, right] = rosterGridColumns(width, margin, ROSTER_CARD_GAP)
      expect(left.left).equals(margin)
      expect(right.left + right.width).closeTo(width - margin, 1e-9)
      expect(right.left - (left.left + left.width)).closeTo(
        ROSTER_CARD_GAP,
        1e-9
      )
      expect(left.width).equals(right.width)
    }
    // Nothing measured yet.
    expect(rosterGridColumns(0, 0, ROSTER_CARD_GAP)[0].width).equals(0)
  })
})
