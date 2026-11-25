import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { caretRows, composerBoxes, paintedFieldRows } from './composerLine'

function frame(
  scale: number,
  caret?: { top: number; height: number; width: number }
): { width: number; height: number; data: Buffer; ratio: number } {
  const width = Math.round(100 * scale)
  const height = Math.round(42 * scale)
  const data = Buffer.alloc(width * height * 4)
  if (caret != null) {
    for (
      let y = Math.round(caret.top * scale);
      y < Math.round((caret.top + caret.height) * scale);
      y++
    ) {
      for (
        let x = Math.round(18 * scale);
        x < Math.round((18 + caret.width) * scale);
        x++
      ) {
        data[(y * width + x) * 4 + 2] = 255
      }
    }
  }
  return { width, height, data, ratio: scale }
}

describe('the painted composer caret', function () {
  it('measures the painted interior when native rectangles include the border', function () {
    const width = 90
    const height = 180
    const data = Buffer.alloc(width * height * 4, 230)
    for (let y = 24; y < 156; y++) {
      const fill = y >= 27 && y < 153 ? 255 : 202
      data.fill(fill, y * width * 4, (y + 1) * width * 4)
    }
    const image = { width, height, data }
    for (const [top, measured] of [
      [26, 126],
      [23, 129]
    ]) {
      assert.deepEqual(paintedFieldRows(image, 0, width, top, measured, 3), {
        top: 27,
        height: 126
      })
    }
    data.fill(255)
    assert.throws(
      () => paintedFieldRows(image, 0, width, 23, 129, 3),
      /visible field borders/
    )
  })

  it('uses the Android app window when its parent has no bounds', async function () {
    const field = { x: 80, y: 700, width: 500, height: 84 }
    const control = { x: 0, y: 698, width: 88, height: 88 }
    const hierarchy = async (): Promise<unknown> => ({
      type: 'Root',
      children: [
        { bounds: { x: 0, y: 0, width: 180, height: 40 } },
        {
          bounds: { x: 0, y: 0, width: 720, height: 1280 },
          children: [
            { id: 'chat-composer', bounds: field },
            { id: 'chat-attachment-toggle', bounds: control }
          ]
        }
      ]
    })
    const boxes = await composerBoxes({ hierarchy }, 'android-app')
    assert.equal(boxes.viewport, 720)
    assert.equal(boxes.units, 2)
    assert.deepEqual(boxes.input, field)
  })

  it('distinguishes the high insertion point from the centered 22-point caret', function () {
    const off = frame(3)
    assert.deepEqual(
      caretRows(off, frame(3, { top: 8, height: 22, width: 2 }), 3),
      { top: 8, bottom: 12 }
    )
    assert.deepEqual(
      caretRows(off, frame(3, { top: 10, height: 22, width: 2 }), 3),
      { top: 10, bottom: 10 }
    )
  })

  it('compares both gaps in logical units on a fractional-density display', function () {
    const scale = 2.625
    const gaps = caretRows(
      frame(scale),
      frame(scale, { top: 11, height: 20, width: 2 }),
      scale
    )
    assert(gaps != null)
    assert(Math.abs(gaps.top - gaps.bottom) < 1)
    assert(Math.abs(gaps.top - 11) < 0.5)
  })

  it('rejects identical screenshots, a dot and a broad moving region', function () {
    const off = frame(1)
    assert.equal(caretRows(off, off, 1), undefined)
    assert.equal(
      caretRows(off, frame(1, { top: 15, height: 3, width: 2 }), 1),
      undefined
    )
    assert.equal(
      caretRows(off, frame(1, { top: 10, height: 22, width: 15 }), 1),
      undefined
    )
  })
})
