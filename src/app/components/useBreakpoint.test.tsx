import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { Text } from 'react-native'

import { render, unmount, windowSize } from '../../test/tessTestKit'
import {
  breakpointFor,
  columnsFor,
  type PaneFrame,
  PaneFrameContext,
  useBreakpoint,
  usePaneFrame,
  usePaneWidth
} from './useBreakpoint'

function Probe(): React.ReactElement {
  const breakpoint = useBreakpoint()
  const frame = usePaneFrame()
  const width = usePaneWidth()
  return (
    <Text testID="probe">{JSON.stringify({ breakpoint, frame, width })}</Text>
  )
}

async function read(frame?: PaneFrame | null): Promise<{
  breakpoint: string
  frame: PaneFrame
  width: number
}> {
  await render(
    frame === undefined ? (
      <Probe />
    ) : (
      <PaneFrameContext.Provider value={frame}>
        <Probe />
      </PaneFrameContext.Provider>
    )
  )
  const text = document.querySelector('[data-testid="probe"]')?.textContent
  return JSON.parse(text ?? '{}')
}

describe('the pane frame', () => {
  let restore: (() => Promise<void>) | undefined
  afterEach(async () => {
    await unmount()
    await restore?.()
    restore = undefined
  })

  it('is the window when nothing provides one', async () => {
    restore = (await windowSize(1280, 900)).restore
    expect(await read()).deep.equals({
      breakpoint: 'desktop',
      frame: { x: 0, y: 0, width: 1280, height: 900 },
      width: 1280
    })
  })

  it('is the window when the provider holds none', async () => {
    restore = (await windowSize(390, 844)).restore
    expect(await read(null)).deep.include({ breakpoint: 'phone', width: 390 })
  })

  it("lays out at the provided frame's width, beside Tess's column", async () => {
    restore = (await windowSize(1280, 900)).restore
    const frame = { x: 400, y: 0, width: 880, height: 900 }
    expect(await read(frame)).deep.equals({
      breakpoint: 'tablet',
      frame,
      width: 880
    })
  })

  it('follows the window across a boundary with no frame', async () => {
    restore = (await windowSize(1280, 900)).restore
    await render(<Probe />)
    const text = (): string =>
      document.querySelector('[data-testid="probe"]')?.textContent ?? ''
    expect(text()).includes('"desktop"')
    await windowSize(500, 900)
    expect(text()).includes('"phone"')
  })

  it('names the breakpoints and their columns', () => {
    expect([599, 600, 1023, 1024].map(breakpointFor)).deep.equals([
      'phone',
      'tablet',
      'tablet',
      'desktop'
    ])
    expect(
      (['phone', 'tablet', 'desktop'] as const).map(columnsFor)
    ).deep.equals([1, 2, 3])
  })
})
