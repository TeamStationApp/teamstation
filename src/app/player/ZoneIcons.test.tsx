import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { placeIcons } from './pressGrid'
import { ZoneIcons } from './ZoneIcons'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

async function draw(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}

/** An icon's circle, as its style places it. */
function circle(name: string): { x: number; y: number; w: number } {
  const node = document.querySelector<HTMLElement>(
    `[data-testid="zoneIcon-${name}"]`
  )!
  return {
    x: Number.parseFloat(node.style.left),
    y: Number.parseFloat(node.style.top),
    w: Number.parseFloat(node.style.width)
  }
}

describe("the press grid's icons, drawn", function () {
  const BOX = { x: 0, y: 0, w: 800, h: 400 }

  it('draw each placed icon as what it does now', async function () {
    const icons = placeIcons(BOX, 48, [], 4, true, { x: 40, y: 40 })
    await draw(
      <ZoneIcons
        icons={icons}
        visible
        playing
        soundOff={false}
        corner="fullscreen"
      />
    )
    const sound = circle('volume_up')
    // The sound and full screen in the top corners.
    expect(sound.x + sound.w / 2).equals(40)
    expect(sound.y + sound.w / 2).equals(40)
    expect(circle('pause').x + circle('pause').w / 2).equals(400)
    expect(circle('fullscreen').x + circle('fullscreen').w / 2).equals(760)
    expect(circle('fullscreen').y + circle('fullscreen').w / 2).equals(40)
    expect(circle('replay_10').y + circle('replay_10').w / 2).equals(200)
    expect(circle('forward_10').y + circle('forward_10').w / 2).equals(200)
  })

  it('show the sound off and play while paused, and nothing in the corner without its icon', async function () {
    const icons = placeIcons(BOX, 48, [], 4, true, { x: 40, y: 40 })
    await draw(
      <ZoneIcons icons={icons} visible={false} playing={false} soundOff />
    )
    expect(circle('volume_off').w).equals(48)
    expect(circle('play_arrow').w).equals(48)
    expect(
      document.querySelector('[data-testid="zoneIcon-fullscreen"]')
    ).equals(null)
  })
})
