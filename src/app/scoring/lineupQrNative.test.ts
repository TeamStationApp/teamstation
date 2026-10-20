// The DOM these tests render into: the coverage scripts run the .ts suites
// without the shared setup, so the file brings its own.
import '../../test/scoringDomSetup.cjs'

import Module from 'node:module'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { lineupQrFixture2 } from './lineupQr.fixtures'
import type * as LineupQrGlyphNative from './LineupQrGlyph.native'
import { lineupQrGlyphPaths } from './lineupQrGlyphs'
import { qrMatrix } from './lineupQrMatrix'
import type * as QrCodeNative from './QrCode.native'

interface Drawn {
  type: string
  name: string
  props: Record<string, unknown>
}

/** A host component that records its props and renders its children. */
const host =
  (type: string, drawn: Drawn[], name = type) =>
  (props: Record<string, unknown> & { children?: ReactNode }) => {
    const { children, ...rest } = props
    drawn.push({ type, name, props: rest })
    return createElement(type, {}, children)
  }

/**
 * Loads native twins against stand-in `react-native` and `react-native-svg`
 * modules, so what a phone build draws is what these tests see.
 */
function loadNative<T>(
  file: string,
  stand: Record<string, Record<string, unknown>>,
  also: string[] = []
): T {
  const names = Object.keys(stand).map(name => require.resolve(name))
  const originals = names.map(name => require.cache[name])
  const own = [file, ...also].map(path => require.resolve(path))
  Object.entries(stand).forEach(([name, exports], k) => {
    const replacement = new Module(names[k])
    replacement.exports = { __esModule: true, ...exports }
    require.cache[names[k]] = replacement
  })
  for (const path of own) Reflect.deleteProperty(require.cache, path)
  try {
    return require(file) as T
  } finally {
    names.forEach((name, k) => {
      if (originals[k] == null) Reflect.deleteProperty(require.cache, name)
      else require.cache[name] = originals[k]
    })
    for (const path of own) Reflect.deleteProperty(require.cache, path)
  }
}

const svgStandIn = (drawn: Drawn[]): Record<string, unknown> => ({
  default: host('svg', drawn),
  Path: host('path', drawn),
  Rect: host('rect', drawn)
})
const render = (element: ReturnType<typeof createElement>): void => {
  const root = createRoot(document.createElement('div'))
  act(() => {
    root.render(element)
  })
  act(() => {
    root.unmount()
  })
}

describe('lineup QR native twins', function () {
  it('draws the QR code as one native path on a white rect', function () {
    const drawn: Drawn[] = []
    const { QrCode } = loadNative<typeof QrCodeNative>('./QrCode.native', {
      'react-native-svg': svgStandIn(drawn)
    })
    render(
      createElement(QrCode, {
        text: lineupQrFixture2.text,
        size: 240,
        accessibilityLabel: 'Lineup QR code'
      })
    )
    const matrix = qrMatrix(lineupQrFixture2.text)
    const svg = drawn.find(node => node.type === 'svg')!
    expect(svg.props).deep.include({
      testID: 'qrCode',
      width: 240,
      accessible: true,
      accessibilityLabel: 'Lineup QR code'
    })
    expect(drawn.find(node => node.type === 'rect')!.props.fill).equals(
      '#ffffff'
    )
    expect(drawn.filter(node => node.type === 'path')).has.length(1)
    expect(drawn.find(node => node.type === 'path')!.props.d).equals(
      matrix.path
    )
  })

  it('draws both glyphs as native strokes', function () {
    const drawn: Drawn[] = []
    const { LineupQrGlyph } = loadNative<typeof LineupQrGlyphNative>(
      './LineupQrGlyph.native',
      { 'react-native-svg': svgStandIn(drawn) }
    )
    render(createElement(LineupQrGlyph, { kind: 'qr', color: '#fff' }))
    render(
      createElement(LineupQrGlyph, {
        kind: 'scan',
        color: '#0f0',
        size: 280,
        strokeWidth: 1
      })
    )
    const paths = drawn.filter(node => node.type === 'path')
    expect(paths.map(node => node.props.d)).deep.equals([
      lineupQrGlyphPaths.qr,
      lineupQrGlyphPaths.scan
    ])
    expect(paths[0].props.strokeWidth).equals(1.7)
    expect(paths[1].props).deep.include({ stroke: '#0f0', strokeWidth: 1 })
    expect(drawn.find(node => node.type === 'svg')!.props.width).equals(24)
  })
})
