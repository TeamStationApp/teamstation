import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'

import { decodeRaster, encodePng } from '../../../src/test/rasterImage'
import type { MaestroDevice } from '../../core/maestro'
import type { E2eContext, Surface, WebSession } from '../../core/spec'
import { type Box, boxOf, flatten, type Node } from '../app/keyboardDock'

const editor = 'chat-composer'

/** Coordinates in hierarchy units, before mapping into screenshot pixels. */
export async function composerBoxes(
  m: MaestroDevice,
  surface: Surface,
  web?: WebSession
): Promise<{
  input: Box
  plus: Box
  send?: Box
  viewport: number
  units: number
}> {
  if (web != null)
    return await web.page.evaluate(() => {
      const box = (id: string): Box => {
        const node = document.querySelector('[data-testid="' + id + '"]')
        if (node == null) throw new Error('Missing ' + id)
        const { x, y, width, height } = node.getBoundingClientRect()
        return { x, y, width, height }
      }
      return {
        input: box('chat-composer'),
        plus: box('chat-attachment-toggle'),
        send:
          document.querySelector('[data-testid="chat-send"]') == null
            ? undefined
            : box('chat-send'),
        viewport: innerWidth,
        units: 1
      }
    })
  const tree = (await m.hierarchy()) as Node
  const nodes = flatten(tree)
  const input = boxOf(nodes.find(node => node.id === editor))
  const plus = boxOf(nodes.find(node => node.id === 'chat-attachment-toggle'))
  const send = boxOf(nodes.find(node => node.id === 'chat-send'))
  const viewport = boxOf(tree)?.width
  assert(
    input != null && plus != null && viewport != null && viewport > 0,
    'Missing field, control or viewport'
  )
  // Hub iOS rectangles are in points; Android rectangles are in physical
  // pixels. The adjacent fixed 44-unit control provides a local ruler.
  return {
    input,
    plus,
    send,
    viewport,
    units: surface === 'ios-app' ? 1 : plus.width / 44
  }
}

/** Capture only the editable surface, excluding other messages and the keyboard. */
async function sample(
  m: MaestroDevice,
  box: Box,
  viewport: number,
  web?: WebSession
): Promise<FieldSample> {
  const bytes =
    web == null
      ? await m.screenshot()
      : await web.page.screenshot({ captureBeyondViewport: false })
  const image = decodeRaster(Buffer.from(bytes))
  const ratio = image.width / viewport
  const left = Math.round(box.x * ratio)
  const top = Math.round(box.y * ratio)
  const width = Math.round((box.x + box.width) * ratio) - left
  const height = Math.round((box.y + box.height) * ratio) - top
  assert(
    left >= 0 &&
      top >= 0 &&
      left + width <= image.width &&
      top + height <= image.height,
    `Composer crop ${left},${top} ${width}×${height} must fit the ${image.width}×${image.height} screenshot`
  )
  const data = Buffer.alloc(width * height * 4)
  for (let row = 0; row < height; row++) {
    const start = ((top + row) * image.width + left) * 4
    image.data.copy(data, row * width * 4, start, start + width * 4)
  }
  return { data, width, height, ratio }
}

interface FieldSample {
  data: Buffer
  width: number
  height: number
  ratio: number
}

/** Locate the blinking insertion stroke; static glyphs and the hint subtract out. */
export function caretRows(
  first: FieldSample,
  next: FieldSample,
  scale: number
): { top: number; bottom: number } | undefined {
  assert.equal(first.width, next.width)
  assert.equal(first.height, next.height)
  const changes = []
  const margin = Math.ceil(5 * scale)
  // Individual caret columns have a solid vertical run. An animated field
  // moving wholesale is too wide and must never count as a caret.
  for (let x = margin; x < first.width - margin; x++) {
    let start = 0
    for (let y = 0; y <= first.height; y++) {
      const i = (y * first.width + x) * 4
      const changed =
        y < first.height &&
        [0, 1, 2].some(
          channel =>
            Math.abs(first.data[i + channel] - next.data[i + channel]) > 45
        )
      if (changed) continue
      const length = y - start
      if (length >= first.height * 0.28 && length <= first.height * 0.9)
        changes.push({ x, top: start, end: y })
      start = y + 1
    }
  }
  if (changes.length === 0) return
  const width = changes.at(-1)!.x - changes[0].x + 1
  if (width > Math.ceil(3.5 * scale)) return
  return {
    top: Math.min(...changes.map(column => column.top)) / scale,
    bottom:
      (first.height - Math.max(...changes.map(column => column.end))) / scale
  }
}

export async function captureComposer(
  ctx: E2eContext,
  m: MaestroDevice,
  web: WebSession | undefined,
  name: string,
  focused = false,
  largeText = false
): Promise<void> {
  const { input, plus, send, viewport, units } = await composerBoxes(
    m,
    ctx.surface,
    web
  )
  const first = await sample(m, input, viewport, web)
  writeFileSync(
    ctx.artifact(name + '.png'),
    encodePng(first.width, first.height, first.data)
  )
  if (!focused) return
  assert(
    Math.abs(plus.width - plus.height) <= units,
    'The reference button is circular'
  )
  const fieldHeight = input.height / units + 2
  if (largeText)
    assert(
      fieldHeight > 45,
      'Enlarged native type must grow the one-line field'
    )
  else {
    assert(
      Math.abs(fieldHeight - 44) <= 1,
      'One line matches the button including its borders'
    )
    for (const button of send == null ? [plus] : [plus, send]) {
      assert(
        Math.abs(button.height / units - 44) <= 1,
        'Adjacent actions have a 44-unit diameter'
      )
      assert(
        Math.abs(button.y + button.height / 2 - input.y - input.height / 2) <=
          units,
        'The line and adjacent action share a vertical center'
      )
    }
  }
  let gaps: { top: number; bottom: number } | undefined
  if (web != null) {
    // Chromium can omit the blinking caret in screenshots. Select the real
    // textarea content to expose its text run; empty fields retain their hint.
    gaps = await web.page.$eval('[data-testid="chat-composer"]', node => {
      const input = node as HTMLTextAreaElement
      const style = getComputedStyle(input)
      const top = parseFloat(style.paddingTop)
      const bottom = input.clientHeight - top - parseFloat(style.lineHeight)
      if (input.value.length !== 0) input.select()
      return { top, bottom }
    })
    const typed = await web.page.$eval(
      '[data-testid="chat-composer"]',
      node => (node as HTMLTextAreaElement).value.length > 0
    )
    if (typed) {
      // Measure the paint of the selected text, independently of CSS.
      const selected = await sample(m, input, viewport, web)
      writeFileSync(
        ctx.artifact(name + '-selection.png'),
        encodePng(selected.width, selected.height, selected.data)
      )
      const rows: number[] = []
      for (let y = 0; y < first.height; y++) {
        let changed = 0
        for (let x = 0; x < first.width; x++) {
          const offset = (y * first.width + x) * 4
          if (
            [0, 1, 2].some(
              c =>
                Math.abs(first.data[offset + c] - selected.data[offset + c]) >
                45
            )
          )
            changed++
        }
        if (changed > 5 * first.ratio) rows.push(y)
      }
      assert(
        rows.length > 0,
        'The selected text must paint a visible highlight'
      )
      gaps = {
        top: rows[0] / first.ratio,
        bottom: (first.height - 1 - rows.at(-1)!) / first.ratio
      }
    }
    await web.page.$eval('[data-testid="chat-composer"]', node => {
      const input = node as HTMLTextAreaElement
      input.setSelectionRange(input.value.length, input.value.length)
    })
  } else {
    for (let i = 0; i < 12 && gaps == null; i++) {
      await wait(137)
      const next = await sample(m, input, viewport)
      gaps = caretRows(first, next, first.ratio * units)
      if (gaps != null) {
        writeFileSync(
          ctx.artifact(name + '-blink.png'),
          encodePng(next.width, next.height, next.data)
        )
      }
    }
  }
  assert(
    gaps != null,
    'Two different phases of a visible insertion caret are required'
  )
  writeFileSync(
    ctx.artifact(name + '.json'),
    JSON.stringify({
      gaps,
      field: input,
      button: plus,
      send,
      largeText,
      pixelsPerUnit: first.ratio * units
    })
  )
  if (largeText) {
    assert(
      gaps.top >= 1 &&
        gaps.bottom >= 1 &&
        input.height / units - gaps.top - gaps.bottom > 22,
      'The enlarged insertion caret must fit inside both borders'
    )
  } else
    assert(
      Math.abs(gaps.top - gaps.bottom) <= 1,
      'Rendered line gaps: ' + JSON.stringify(gaps)
    )
}
