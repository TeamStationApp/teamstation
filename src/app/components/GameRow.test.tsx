import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { GameRow } from './GameRow'
import { thumbBox } from './thumbBox'

let root: Root | undefined
let host: HTMLElement | undefined

async function render(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

const row = (
  <GameRow
    first="Badgers"
    second="@ Sox"
    detail="Sun, Oct 4 · 4:45 PM"
    posterUrl="https://example.com/poster.jpg"
    length="1:30:00"
    badgeLabel="4–0"
    badgeTone="neutral"
    onPress={() => undefined}
  />
)

function leaf(container: HTMLElement, text: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('*')).find(
    node => node.children.length === 0 && node.textContent === text
  )
}

function columnOf(container: HTMLElement): HTMLElement {
  const name = leaf(container, 'Badgers')
  const column = name?.parentElement?.parentElement
  if (column == null) throw new Error('no text column')
  return column
}

function frameOf(container: HTMLElement): HTMLElement {
  const marked = container.querySelector('[aria-label="Play"]')
  const frame = marked?.parentElement
  if (frame == null) throw new Error('no poster frame')
  return frame
}

function pictureOf(frame: HTMLElement): HTMLElement {
  const picture = Array.from(frame.querySelectorAll('div')).find(
    node => getComputedStyle(node).backgroundSize === 'cover'
  )
  if (picture == null) throw new Error('no picture')
  return picture
}

interface LayoutHost extends HTMLElement {
  __reactLayoutHandler?: (event: {
    nativeEvent: { layout: { height: number } }
  }) => void
}

function fallbackTextHeight(): number {
  const rem = tsBallpark.rem
  return 2 * rem(1) + rem(0.875) + 2 * rem(0.0625)
}

async function reportHeight(
  column: HTMLElement,
  height: number
): Promise<void> {
  const host = column as LayoutHost
  const report = host.__reactLayoutHandler
  if (report == null) throw new Error('the column does not report its height')
  await act(async () => {
    report({ nativeEvent: { layout: { height } } })
  })
}

describe('GameRow thumbnail', function () {
  it('is 4:3 at the width of a 16:9 frame of the text, before it is measured', async function () {
    const container = await render(row)
    const box = thumbBox(fallbackTextHeight())
    const style = getComputedStyle(frameOf(container))
    expect(Number.parseFloat(style.width)).closeTo(box.width, 0.01)
    expect(Number.parseFloat(style.height)).closeTo(box.height, 0.01)
    expect(style.height).not.equals('100%')
    const picture = getComputedStyle(pictureOf(frameOf(container)))
    expect(picture.backgroundSize).equals('cover')
    expect(picture.objectFit).equals('cover')
  })

  it('follows the measured column, and ignores a report of no height', async function () {
    const container = await render(row)
    const column = columnOf(container)
    await reportHeight(column, 0)
    const fallback = thumbBox(fallbackTextHeight())
    expect(
      Number.parseFloat(getComputedStyle(frameOf(container)).width)
    ).closeTo(fallback.width, 0.01)
    await reportHeight(column, 72)
    const measured = thumbBox(72)
    const style = getComputedStyle(frameOf(container))
    expect(Number.parseFloat(style.width)).closeTo(measured.width, 0.01)
    expect(Number.parseFloat(style.height)).closeTo(measured.height, 0.01)
    expect(style.height).not.equals('100%')
  })

  it('sizes the picture from the three shared lines, not the venue', async function () {
    const container = await render(
      <GameRow
        first="Badgers"
        second="@ Sox"
        detail="Sun, Oct 4 · 4:45 PM"
        venue="Poway National Little League"
        posterUrl="https://example.com/poster.jpg"
        length="1:30:00"
        onPress={() => undefined}
      />
    )
    const column = columnOf(container)
    const venue = leaf(container, 'Poway National Little League')
    if (venue == null) throw new Error('no venue')
    expect(column.contains(venue)).equals(false)
    await reportHeight(column, 72)
    const measured = thumbBox(72)
    const style = getComputedStyle(frameOf(container))
    expect(Number.parseFloat(style.width)).closeTo(measured.width, 0.01)
    expect(Number.parseFloat(style.height)).closeTo(measured.height, 0.01)
  })
})

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function setWidth(width: number): Promise<void> {
  await act(async () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      get: () => width
    })
    window.dispatchEvent(new window.Event('resize'))
    await delay(10)
  })
}

describe('GameRow result', function () {
  afterEach(async function () {
    await act(async () => {
      delete (document.documentElement as unknown as Record<string, unknown>)
        .clientWidth
      window.dispatchEvent(new window.Event('resize'))
    })
  })

  it('keeps the pill and, on a desktop, the chevron on the first line only', async function () {
    const container = await render(row)
    const badge = leaf(container, '4–0')?.parentElement
    const firstLine = leaf(container, 'Badgers')?.parentElement
    const second = leaf(container, '@ Sox')
    const detail = leaf(container, 'Sun, Oct 4 · 4:45 PM')
    if (
      badge == null ||
      firstLine == null ||
      second == null ||
      detail == null
    ) {
      throw new Error('the row is missing a line')
    }
    expect(badge.parentElement).equals(firstLine)
    expect(firstLine.contains(second)).equals(false)
    expect(firstLine.contains(detail)).equals(false)
    expect(leaf(container, 'chevron_right')).equals(undefined)

    await setWidth(1440)
    const chevron = leaf(container, 'chevron_right')
    if (chevron == null) throw new Error('no chevron on a desktop')
    expect(chevron.parentElement).equals(
      leaf(container, 'Badgers')?.parentElement
    )
    expect(
      chevron.parentElement?.contains(leaf(container, '@ Sox') ?? chevron)
    ).equals(false)
  })
})
