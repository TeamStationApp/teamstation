import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import {
  byLabel,
  click,
  render,
  settle,
  unmount,
  windowSize
} from '../../test/tessTestKit'
import { ChildCard } from './ChildCard'
import { type PaneFrame, PaneFrameProvider } from './useBreakpoint'

// On the HTML elements' own prototype, which another suite may have given
// a box of its own, and put back as it was found.
const element = window.HTMLElement.prototype
const originalBox = Object.getOwnPropertyDescriptor(
  element,
  'getBoundingClientRect'
)

/** Where the ⋮ menu opened, from the window's right edge, in points. */
async function menuRight(frame?: PaneFrame): Promise<number> {
  const card = (
    <ChildCard
      kind="team"
      title="Demo Hawks"
      imageUrl={null}
      onPress={() => undefined}
      actions={[{ label: 'Leave season', onPress: () => undefined }]}
    />
  )
  await render(
    frame == null ? (
      card
    ) : (
      <PaneFrameProvider frame={frame}>{card}</PaneFrameProvider>
    )
  )
  await click(byLabel('More for Demo Hawks'))
  await settle()
  const menu = byLabel('Leave season').parentElement!
  return Number.parseFloat(menu.style.right)
}

describe("a child card's menu", () => {
  let restore: (() => Promise<void>) | undefined
  afterEach(async () => {
    await unmount()
    await restore?.()
    restore = undefined
    if (originalBox == null)
      Reflect.deleteProperty(element, 'getBoundingClientRect')
    else Object.defineProperty(element, 'getBoundingClientRect', originalBox)
  })

  it("opens under its ⋮, measured from the pane's right edge", async () => {
    restore = (await windowSize(1280)).restore
    // The ⋮ sits 900 points in, 40 wide.
    const box: Partial<DOMRect> = {
      x: 900,
      y: 100,
      left: 900,
      top: 100,
      width: 40,
      height: 40
    }
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => box
    })
    expect(await menuRight(), 'the window').equals(340)
    await unmount()
    // Beside Tess's column the pane ends where the window does.
    expect(
      await menuRight({ x: 400, y: 0, width: 880, height: 900 }),
      'beside Tess'
    ).equals(340)
    await unmount()
    expect(
      await menuRight({ x: 0, y: 0, width: 1000, height: 900 }),
      'a pane short of the right edge'
    ).equals(60)
  })
})
