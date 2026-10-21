import { expect } from 'chai'
import { describe, it } from 'mocha'

import { lineupQrFixture4 } from './lineupQr.fixtures'
import { qrMatrix, QUIET_ZONE } from './lineupQrMatrix'

/** The modules a path's `M x y h n v1 h-n z` runs cover, quiet zone removed. */
const painted = (path: string): Set<string> => {
  const cells = new Set<string>()
  for (const [, x, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g))
    for (let k = 0; k < Number(run); k++)
      cells.add(`${Number(x) - QUIET_ZONE + k},${Number(y) - QUIET_ZONE}`)
  return cells
}
const finderAt = (
  dark: (x: number, y: number) => boolean,
  x0: number,
  y0: number
): boolean => {
  for (let y = 0; y < 7; y++)
    for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      if (dark(x0 + x, y0 + y) !== (ring !== 2)) return false
    }
  return true
}

describe('lineup QR matrix', function () {
  it('holds a long lineup in the smallest version that fits', function () {
    const text = lineupQrFixture4.text.padEnd(750, 'A')
    const { size } = qrMatrix(text)
    expect((size - 17) % 4).equals(0)
    const version = (size - 17) / 4
    expect(version).within(15, 20)
    expect(qrMatrix('A').size).equals(21)
  })

  it('places finder patterns in three corners and not the fourth', function () {
    const { size, dark } = qrMatrix(lineupQrFixture4.text)
    expect(finderAt(dark, 0, 0)).equals(true)
    expect(finderAt(dark, size - 7, 0)).equals(true)
    expect(finderAt(dark, 0, size - 7)).equals(true)
    expect(finderAt(dark, size - 7, size - 7)).equals(false)
  })

  it('paints exactly the dark modules', function () {
    const { size, dark, path } = qrMatrix(lineupQrFixture4.text)
    const cells = painted(path)
    let count = 0
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (dark(x, y)) {
          count++
          expect(cells.has(`${x},${y}`), `${x},${y}`).equals(true)
        }
    expect(cells.size).equals(count)
  })
})
