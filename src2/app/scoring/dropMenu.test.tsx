import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  type DropMenu,
  type DropMenuOptions,
  dropRowAt,
  inDropRect,
  leftDropMenu,
  useDropMenu
} from './dropMenu'

let root: Root | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})

interface Harness {
  menu: () => DropMenu
  chosen: string[]
  active: boolean[]
  rerender: (options: Partial<DropMenuOptions>) => Promise<void>
}

async function harness(
  options: Partial<DropMenuOptions> = {}
): Promise<Harness> {
  let current: DropMenu | undefined
  const chosen: string[] = []
  const active: boolean[] = []
  function Probe(props: DropMenuOptions): null {
    current = useDropMenu(props)
    return null
  }
  const base: DropMenuOptions = {
    disabled: false,
    childKey: 'Out',
    escape: false,
    onActive: value => active.push(value),
    canChoose: key => key !== 'Dim',
    onChoose: key => chosen.push(key),
    ...options
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<Probe {...base} />)
  })
  return {
    menu: () => current!,
    chosen,
    active,
    rerender: async next => {
      await act(async () => {
        root?.render(<Probe {...base} {...next} />)
      })
    }
  }
}

/** A panel at x 200–300 with three 40-point rows above y 600, and a child to its left. */
function lay(menu: DropMenu): void {
  menu.setPanel('parent', { x: 200, y: 480, width: 100, height: 120 })
  menu.setRow('Single', { x: 200, y: 480, width: 100, height: 40 })
  menu.setRow('Dim', { x: 200, y: 520, width: 100, height: 40 })
  menu.setRow('Out', { x: 200, y: 560, width: 100, height: 40 })
}
function layChild(menu: DropMenu): void {
  menu.setPanel('child', { x: 80, y: 540, width: 100, height: 80 })
  menu.setRow('Caught', { x: 80, y: 540, width: 100, height: 40 })
  menu.setRow('Thrown', { x: 80, y: 580, width: 100, height: 40 })
}

describe('drop menu geometry', function () {
  it('finds the row under a point', function () {
    const rows = new Map([
      ['a', { x: 0, y: 0, width: 10, height: 10 }],
      ['b', { x: 0, y: 10, width: 10, height: 10 }]
    ])
    expect(dropRowAt(rows, 5, 15)).equals('b')
    expect(dropRowAt(rows, 15, 5)).equals(undefined)
    expect(inDropRect(undefined, 0, 0)).equals(false)
  })
  it('lets a drag cross to the submenu and travel up from the button without leaving', function () {
    const parent = { x: 0, y: 100, width: 100, height: 100 }
    const child = { x: 120, y: 120, width: 100, height: 60 }
    expect(leftDropMenu({ x: 50, y: 150 }, 300, parent, child)).equals(false)
    expect(leftDropMenu({ x: 150, y: 150 }, 300, parent, child)).equals(false)
    expect(leftDropMenu({ x: 110, y: 150 }, 300, parent, child)).equals(false)
    expect(leftDropMenu({ x: 50, y: 250 }, 300, parent, child)).equals(false)
    expect(leftDropMenu({ x: 110, y: 110 }, 300, parent, child)).equals(true)
    expect(leftDropMenu({ x: 300, y: 150 }, 300, parent, child)).equals(true)
    expect(leftDropMenu({ x: 300, y: 150 }, 300, undefined, child)).equals(
      false
    )
    const left = { x: -120, y: 120, width: 100, height: 60 }
    expect(leftDropMenu({ x: -10, y: 150 }, 300, parent, left)).equals(false)
  })
})

describe('the phone drop menu', function () {
  it('opens and closes on a tap, and chooses a tapped row', async function () {
    const h = await harness()
    await act(async () => {
      h.menu().toggle()
    })
    expect(h.menu().open).equals(true)
    expect(h.menu().mode).equals('tap')
    await act(async () => {
      h.menu().toggle()
    })
    expect(h.menu().open).equals(false)
    await act(async () => {
      h.menu().toggle()
    })
    await act(async () => {
      h.menu().select('Dim')
    })
    expect(h.chosen).deep.equals([])
    await act(async () => {
      h.menu().select('Out')
    })
    expect(h.menu().child).equals(true)
    await act(async () => {
      h.menu().select('Single')
    })
    expect(h.chosen).deep.equals(['Single'])
    expect(h.menu().open).equals(false)
    expect(h.active).deep.equals([true, false, true, false])
  })
  it('opens under a finger dragged up, lights rows, opens the submenu and chooses on release', async function () {
    const h = await harness()
    await act(async () => {
      h.menu().begin(250, 700)
      h.menu().move(250, 695)
    })
    expect(h.menu().open).equals(false)
    await act(async () => {
      h.menu().move(250, 690)
    })
    expect(h.menu().open).equals(true)
    expect(h.menu().mode).equals('drag')
    lay(h.menu())
    await act(async () => {
      h.menu().move(250, 500)
    })
    expect(h.menu().hover).equals('Single')
    await act(async () => {
      h.menu().move(250, 540)
    })
    expect(h.menu().hover).equals(undefined)
    await act(async () => {
      h.menu().move(250, 580)
    })
    expect(h.menu().child).equals(true)
    layChild(h.menu())
    await act(async () => {
      h.menu().move(130, 600)
    })
    expect(h.menu().hover).equals('Thrown')
    expect(h.menu().child).equals(true)
    await act(async () => {
      h.menu().move(250, 500)
    })
    expect(h.menu().child).equals(false)
    await act(async () => {
      h.menu().move(250, 580)
    })
    await act(async () => {
      h.menu().move(130, 560)
      h.menu().end(130, 560)
    })
    expect(h.chosen).deep.equals(['Caught'])
    expect(h.menu().open).equals(false)
    expect(h.menu().rowRect('Single')).deep.equals({
      x: 200,
      y: 480,
      width: 100,
      height: 40
    })
  })
  it('closes without choosing on a release over nothing, the submenu row, or a cancel', async function () {
    const h = await harness()
    for (const [x, y] of [
      [10, 10],
      [250, 580]
    ]) {
      await act(async () => {
        h.menu().begin(250, 700)
        h.menu().move(250, 600)
      })
      lay(h.menu())
      await act(async () => {
        h.menu().end(x, y)
      })
      expect(h.menu().open).equals(false)
    }
    await act(async () => {
      h.menu().begin(250, 700)
      h.menu().move(250, 600)
    })
    await act(async () => {
      h.menu().cancel()
    })
    expect(h.menu().open).equals(false)
    // A tap-sized press is no drag: nothing to end or cancel.
    await act(async () => {
      h.menu().begin(250, 700)
      h.menu().end(250, 700)
      h.menu().cancel()
      h.menu().end(0, 0)
    })
    expect(h.chosen).deep.equals([])
  })
  it("closes More's menu when a drag leaves it, and ignores the rest of that drag", async function () {
    const h = await harness({ escape: true })
    await act(async () => {
      h.menu().begin(250, 700)
      h.menu().move(250, 600)
    })
    lay(h.menu())
    await act(async () => {
      h.menu().move(250, 650)
    })
    expect(h.menu().open).equals(true)
    await act(async () => {
      h.menu().move(600, 500)
    })
    expect(h.menu().open).equals(false)
    await act(async () => {
      h.menu().move(250, 500)
      h.menu().end(250, 500)
    })
    expect(h.menu().open).equals(false)
    expect(h.chosen).deep.equals([])
  })
  it('does nothing while disabled, and closes when it becomes so', async function () {
    const h = await harness()
    await act(async () => {
      h.menu().toggle()
    })
    await h.rerender({ disabled: true })
    expect(h.menu().open).equals(false)
    await act(async () => {
      h.menu().toggle()
      h.menu().begin(250, 700)
      h.menu().move(250, 600)
      h.menu().select('Single')
    })
    expect(h.menu().open).equals(false)
    expect(h.chosen).deep.equals([])
    await h.rerender({ disabled: false, canChoose: () => false })
    await act(async () => {
      h.menu().select('Out')
    })
    expect(h.menu().child).equals(false)
    h.menu().setRow('Single', undefined)
    h.menu().setPanel('child', undefined)
    expect(h.menu().rowRect('Single')).equals(undefined)
  })
})
