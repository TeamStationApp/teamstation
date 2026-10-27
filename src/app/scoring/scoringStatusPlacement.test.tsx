import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  bandedBounds,
  bandedField,
  bandedSafe,
  BaseballScreen,
  fieldHolderStyle,
  useBandedReports
} from '../field/BaseballScreen'
import { FIELD_EDGE_GAP } from '../field/fieldSafeArea'
import type { BaseProjection, FieldCanvasProps } from '../field/fieldTypes'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  CONTROL_DECK_HEIGHT,
  CONTROL_GAP,
  CONTROL_HEIGHT
} from './scoringControlStyle'
import {
  SCORING_OFFLINE_BAND,
  scoringOfflineFrame,
  scoringStatusFrame
} from './scoringStatusPlacement'

/** An iPhone 15 Pro held upright: the island and the home indicator. */
const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 }

describe('the scoring status line placement', function () {
  it('sits on a phone above the deck and the band of controls on it, never at the top', function () {
    const frame = scoringStatusFrame(true, IPHONE)
    expect(frame).not.have.property('top')
    // The deck's top edge, as the field's safe padding leaves it.
    const deckTop = IPHONE.bottom + FIELD_EDGE_GAP + CONTROL_DECK_HEIGHT
    expect(frame.bottom).equals(
      deckTop + CONTROL_GAP + CONTROL_HEIGHT + CONTROL_GAP
    )
    expect(frame.bottom).equals(234)
    expect(frame).deep.include({
      position: 'absolute',
      left: FIELD_EDGE_GAP,
      right: FIELD_EDGE_GAP,
      alignItems: 'center'
    })
    // A phone on its side keeps clear of the notch on either edge.
    expect(
      scoringStatusFrame(true, { top: 0, bottom: 21, left: 59, right: 47 })
    ).deep.include({ left: 59, right: 47, bottom: 21 + 200 })
  })

  it('stays centred 8 from the top on the web, as it always was', function () {
    expect(scoringStatusFrame(false, IPHONE)).deep.equals({
      position: 'absolute',
      top: FIELD_EDGE_GAP,
      left: 0,
      right: 0,
      alignItems: 'center'
    })
  })
})

describe('the offline line’s band at the top', function () {
  let root: Root | undefined
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })
  const screen = (band?: number): React.ReactElement => (
    <ThemeProvider>
      <BaseballScreen
        field={{
          players: [],
          selected: '',
          onSelect: () => undefined,
          view: 'home',
          zoom: 1
        }}
        onMenu={() => undefined}
        onUndo={() => undefined}
        onPitch={() => undefined}
        canPitch
        summary="Game"
        topBand={band}
      />
    </ThemeProvider>
  )
  /** The field's holder, moved down by the band (never resized). */
  const margins = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('div')]
      .map(node => node.style.transform)
      .filter(moved => moved.includes(`translateY(${SCORING_OFFLINE_BAND}px)`))

  it('fills a band from the very top on a phone, the line in its last 28 points under the status bar', function () {
    expect(scoringOfflineFrame(true, IPHONE, '#123456')).deep.equals({
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      paddingTop: 59,
      height: 59 + SCORING_OFFLINE_BAND,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#123456'
    })
    expect(SCORING_OFFLINE_BAND).equals(28)
    expect(
      scoringOfflineFrame(
        true,
        { top: 0, bottom: 21, left: 59, right: 47 },
        '#123456'
      ).paddingTop
    ).equals(FIELD_EDGE_GAP)
    // The web's line keeps its place above the board, with no fill.
    expect(scoringOfflineFrame(false, IPHONE, '#123456')).deep.equals({
      position: 'absolute',
      top: FIELD_EDGE_GAP,
      left: 0,
      right: 0,
      height: SCORING_OFFLINE_BAND,
      alignItems: 'center',
      justifyContent: 'center'
    })
  })

  it('moves the header row down by the band, on a phone and on the web', function () {
    expect(bandedSafe({ paddingTop: 59, paddingLeft: 8 }, 28)).deep.equals({
      paddingTop: 87,
      paddingLeft: 8
    })
    expect(
      bandedSafe(
        {
          paddingTop: 'max(8px, env(safe-area-inset-top))'
        },
        28
      ).paddingTop
    ).equals('calc(max(8px, env(safe-area-inset-top)) + 28px)')
    expect(bandedSafe({}, 28).paddingTop).equals('28px')
    const safe = { paddingTop: 59 }
    expect(bandedSafe(safe, 0)).equals(safe)
  })

  it('moves the field down under the band, keeping its size', function () {
    expect(fieldHolderStyle(0)).deep.equals({ flex: 1 })
    expect(fieldHolderStyle(28)).deep.equals({
      flex: 1,
      transform: [{ translateY: 28 }]
    })
  })

  it('moves every screen point the canvas reports down by the band', function () {
    const heard: unknown[] = []
    const field = {
      players: [],
      selected: '',
      onSelect: () => undefined,
      view: 'home' as const,
      zoom: 1,
      onBaseProjection: (value: unknown) => heard.push(['bases', value]),
      onRunnerDrag: (value: unknown) => heard.push(['drag', value]),
      onRunnerHold: (id: string, anchor: unknown) =>
        heard.push(['hold', id, anchor])
    }
    expect(bandedField(field, 0)).equals(field)
    const banded = bandedField(field, 28)
    banded.onBaseProjection!({
      bases: [{ x: 10, y: 100 }],
      heads: [{ x: 1, y: 2 }],
      feet: [{ x: 3, y: 4 }],
      width: 393,
      height: 700
    })
    banded.onBaseProjection!({
      bases: [{ x: 10, y: 100 }],
      width: 1,
      height: 1
    })
    const rect = { x: 5, y: 50, width: 40, height: 20 }
    banded.onRunnerDrag!({
      id: 'r1',
      from: 0,
      to: 1,
      progress: 0.5,
      point: { x: 7, z: 9 },
      safe: rect,
      out: rect
    })
    banded.onRunnerDrag!(null)
    banded.onRunnerHold!('r1', { x: 20, y: 30 })
    expect(heard).deep.equals([
      [
        'bases',
        {
          bases: [{ x: 10, y: 128 }],
          heads: [{ x: 1, y: 30 }],
          feet: [{ x: 3, y: 32 }],
          width: 393,
          height: 700
        }
      ],
      ['bases', { bases: [{ x: 10, y: 128 }], width: 1, height: 1 }],
      [
        'drag',
        {
          id: 'r1',
          from: 0,
          to: 1,
          progress: 0.5,
          // A ground point is the field's own: it does not move.
          point: { x: 7, z: 9 },
          safe: { ...rect, y: 78 },
          out: { ...rect, y: 78 }
        }
      ],
      ['drag', null],
      ['hold', 'r1', { x: 20, y: 58 }]
    ])
    // A field with none of them stays as it is, but for the band.
    const bare = bandedField(
      {
        ...field,
        onBaseProjection: undefined,
        onRunnerDrag: undefined,
        onRunnerHold: undefined
      },
      28
    )
    expect(bare.onBaseProjection).equals(undefined)
  })

  it('puts the scoreboard below the band', function () {
    // The canvas never puts the board higher than 62 from its own top.
    const canvas = { x: 12, y: 62, width: 300, height: 60 }
    const board = bandedBounds(canvas, SCORING_OFFLINE_BAND)
    expect(board).deep.equals({ ...canvas, y: 90 })
    const bandBottom = Number(
      scoringOfflineFrame(true, IPHONE, '#123456').height
    )
    expect(bandBottom).equals(87)
    expect(board.y).greaterThan(bandBottom)
    expect(bandedBounds(canvas, 0)).equals(canvas)
  })

  it('moves the last bases and board when the band comes and goes, with no new canvas report', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const seen: BaseProjection[] = []
    const field: FieldCanvasProps = {
      players: [],
      selected: '',
      onSelect: () => undefined,
      view: 'home',
      zoom: 1,
      onBaseProjection: projection => seen.push(projection)
    }
    let reports: ReturnType<typeof useBandedReports> | undefined
    function Probe(props: { band: number }): null {
      reports = useBandedReports(field, props.band)
      return null
    }
    await act(async () => {
      root!.render(<Probe band={0} />)
    })
    // The canvas reports once; it never reports these values again.
    await act(async () => {
      reports!.field.onBaseProjection!({
        bases: [{ x: 100, y: 400 }],
        width: 390,
        height: 844
      })
      reports!.onScoreboardBounds({ x: 12, y: 62, width: 300, height: 60 })
    })
    expect(seen.map(p => p.bases[0].y)).deep.equals([400])
    expect(reports!.bounds?.y).equals(62)
    await act(async () => {
      root!.render(<Probe band={SCORING_OFFLINE_BAND} />)
    })
    expect(seen.map(p => p.bases[0].y)).deep.equals([400, 428])
    expect(reports!.bounds?.y).equals(90)
    await act(async () => {
      root!.render(<Probe band={0} />)
    })
    expect(seen.map(p => p.bases[0].y)).deep.equals([400, 428, 400])
    expect(reports!.bounds?.y).equals(62)
  })

  it('starts the field under the band only while there is one', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(screen())
    })
    expect(margins()).deep.equals([])
    await act(async () => {
      root!.render(screen(SCORING_OFFLINE_BAND))
    })
    expect(margins()).deep.equals(['translateY(28px)'])
    await act(async () => {
      root!.render(screen(0))
    })
    expect(margins()).deep.equals([])
  })
})
