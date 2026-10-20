import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { lineupQrFixture2 } from './lineupQr.fixtures'
import { LineupQrGlyph } from './LineupQrGlyph'
import { lineupQrGlyphPaths } from './lineupQrGlyphs'
import { qrMatrix, QUIET_ZONE } from './lineupQrMatrix'
import { QrCode } from './QrCode'

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => {
    root.render(element)
  })
  return host
}

describe('lineup QR code view', function () {
  it('draws the matrix as one black path on white, with a four-module quiet zone', function () {
    const host = render(
      <QrCode
        text={lineupQrFixture2.text}
        size={280}
        accessibilityLabel="Lineup QR code"
      />
    )
    const svg = host.querySelector('svg[data-testid="qrCode"]')!
    const matrix = qrMatrix(lineupQrFixture2.text)
    const box = matrix.size + 2 * QUIET_ZONE
    expect(svg.getAttribute('viewBox')).equals(`0 0 ${box} ${box}`)
    expect(svg.getAttribute('width')).equals('280')
    expect(svg.getAttribute('aria-label')).equals('Lineup QR code')
    expect(svg.querySelector('rect')!.getAttribute('fill')).equals('#ffffff')
    const paths = svg.querySelectorAll('path')
    expect(paths).has.length(1)
    expect(paths[0].getAttribute('d')).equals(matrix.path)
    expect(paths[0].getAttribute('fill')).equals('#000000')
    // Nothing is painted inside the quiet zone.
    const starts = [...matrix.path.matchAll(/M(\d+) (\d+)/g)].map(m => [
      Number(m[1]),
      Number(m[2])
    ])
    expect(Math.min(...starts.flat())).equals(QUIET_ZONE)
  })

  it('draws the QR and scan glyphs as strokes', function () {
    const host = render(
      <>
        <LineupQrGlyph kind="qr" color="#fff" />
        <LineupQrGlyph kind="scan" color="#0f0" size={280} strokeWidth={1} />
      </>
    )
    const qr = host.querySelector('[data-testid="lineupQrGlyph-qr"]')!
    expect(qr.getAttribute('width')).equals('24')
    expect(qr.querySelector('path')!.getAttribute('d')).equals(
      lineupQrGlyphPaths.qr
    )
    const scan = host.querySelector('[data-testid="lineupQrGlyph-scan"] path')!
    expect(scan.getAttribute('stroke')).equals('#0f0')
    expect(scan.getAttribute('stroke-width')).equals('1')
    expect(scan.getAttribute('d')).equals(lineupQrGlyphPaths.scan)
  })
})
