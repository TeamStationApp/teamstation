import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { gsBallpark } from '../theme/gsBallpark'
import { gsDark } from '../theme/gsDark'
import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { TsMark } from './TsMark'
import { MARK_PATHS, MARK_STROKE_WIDTH, MARK_VIEW_BOX } from './tsMarkPaths'

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
    changeTheme(gsBallpark)
  })
  root = undefined
  host?.remove()
  host = undefined
})

function stops(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('stop')).map(
    stop => stop.getAttribute('stop-color') ?? ''
  )
}

describe('the TeamStation mark', function () {
  it('draws the three strokes of the square and its arcs, over nothing', async function () {
    const container = await render(<TsMark />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).equals(MARK_VIEW_BOX)
    expect(MARK_VIEW_BOX).equals('24 24 464 464')
    expect(svg?.getAttribute('aria-label')).equals('TeamStation')
    const paths = Array.from(container.querySelectorAll('path')).map(path =>
      path.getAttribute('d')
    )
    expect(paths).deep.equals(MARK_PATHS)
    expect(paths).length(3)
    const group = container.querySelector('g')
    expect(group?.getAttribute('fill')).equals('none')
    expect(group?.getAttribute('stroke-width')).equals(
      String(MARK_STROKE_WIDTH)
    )
    expect(MARK_STROKE_WIDTH).equals(50)
  })

  it("strokes with the theme's gradient, light green to dark on the pale theme", async function () {
    const container = await render(<TsMark />)
    expect(stops(container)).deep.equals([
      gsBallpark.markGradientStart,
      gsBallpark.markGradientEnd
    ])
    expect(gsBallpark.markGradientStart).equals('#5e8f32')
    expect(gsBallpark.markGradientEnd).equals('#182e16')
    const gradient = container.querySelector('linearGradient')
    const id = gradient?.getAttribute('id') ?? ''
    expect(container.querySelector('g')?.getAttribute('stroke')).equals(
      `url(#${id})`
    )
    expect(gradient?.getAttribute('gradientUnits')).equals('userSpaceOnUse')
    expect(
      Array.from(container.querySelectorAll('stop')).map(stop =>
        stop.getAttribute('offset')
      )
    ).deep.equals(['0.4', '0.6'])
  })

  it('runs to the cream on the dark theme, so the mark stays whole on a dark header', async function () {
    await act(async () => {
      changeTheme(gsDark)
    })
    const container = await render(<TsMark />)
    expect(stops(container)).deep.equals(['#8FB35C', '#E6E5D5'])
  })

  it('gives two marks on one page two gradients', async function () {
    const container = await render(
      <>
        <TsMark />
        <TsMark size={3} />
      </>
    )
    const ids = Array.from(container.querySelectorAll('linearGradient')).map(
      gradient => gradient.getAttribute('id')
    )
    expect(new Set(ids).size).equals(2)
  })
})
