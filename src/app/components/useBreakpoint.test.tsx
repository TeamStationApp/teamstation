import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { Text } from 'react-native'

import { render, rerender, unmount, windowSize } from '../../test/tessTestKit'
import {
  breakpointFor,
  columnsFor,
  type PaneFrame,
  PaneFrameProvider,
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
      <PaneFrameProvider frame={frame}>
        <Probe />
      </PaneFrameProvider>
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

  it('redraws a screen that reads only the breakpoint when the frame crosses a boundary, not with each pixel', async () => {
    restore = (await windowSize(1280, 900)).restore
    let renders = 0
    const Reader = React.memo(function Reader(): React.ReactElement {
      renders += 1
      return <Text testID="reader">{useBreakpoint()}</Text>
    })
    const reader = <Reader />
    const at = async (width: number): Promise<string> => {
      await rerender(
        <PaneFrameProvider frame={{ x: 400, y: 0, width, height: 900 }}>
          {reader}
        </PaneFrameProvider>
      )
      return document.querySelector('[data-testid="reader"]')?.textContent ?? ''
    }
    await render(<PaneFrameProvider frame={null}>{reader}</PaneFrameProvider>)
    expect(renders).equals(1)
    expect(await at(880)).equals('tablet')
    expect(renders).equals(2)
    for (const width of [881, 900, 1000, 1023]) await at(width)
    expect(renders).equals(2)
    expect(await at(1024)).equals('desktop')
    expect(renders).equals(3)
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
