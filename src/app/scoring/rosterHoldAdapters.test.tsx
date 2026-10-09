import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { Button } from '../components/Button'
import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { RosterDrag } from './RosterDrag'
import { RosterContext } from './RosterDragContext'
import type { RosterDragProps } from './rosterDragProps'
import { RosterGesture } from './rosterGesture'
import { RosterRemoveButton } from './RosterRemoveButton'

let root: Root | undefined
const wait = async (): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 510))
  })
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    changeTheme(tsBallpark)
  })
  document.body.innerHTML = ''
})
async function setup(extra: Partial<RosterDragProps> = {}): Promise<{
  engine: RosterGesture
  row: HTMLElement
  taps: number[]
  drops: number[]
}> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const engine = new RosterGesture(() => undefined)
  const taps: number[] = []
  const drops: number[] = []
  engine.targets.set('dest', {
    measure: async () => ({ x: 100, y: 0, width: 100, height: 100 }),
    drop: id => drops.push(id)
  })
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <RosterContext.Provider value={engine}>
          <RosterDrag
            playerId={1}
            label="One"
            onTap={() => taps.push(1)}
            {...extra}
          >
            <span>One</span>
            <button>Child</button>
          </RosterDrag>
        </RosterContext.Provider>
      </ThemeProvider>
    )
  })
  return {
    engine,
    row: host.querySelector('[data-roster-player]')!,
    taps,
    drops
  }
}
async function touch(
  row: HTMLElement,
  type: string,
  x: number,
  y = 10,
  multi = false
): Promise<Event> {
  const e = new window.Event(type, { bubbles: true, cancelable: true })
  const point = { identifier: 1, clientX: x, clientY: y }
  Object.defineProperties(e, {
    touches: { value: multi ? [point, { ...point, identifier: 2 }] : [point] },
    changedTouches: { value: [point] }
  })
  await act(async () => {
    row.dispatchEvent(e)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  return e
}
describe('roster hold platform adapters', function () {
  it('drags a defensive roster card immediately with a mouse and drops once', async () => {
    const { engine, row, taps, drops } = await setup({
      immediateMouseDrag: true,
      onTap: undefined
    })
    const pointer = async (type: string, x: number): Promise<void> => {
      const event = new window.MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: 10,
        button: 0,
        relatedTarget: type === 'pointerout' ? document.body : null
      })
      Object.defineProperties(event, {
        pointerType: { value: 'mouse' },
        pointerId: { value: 1 }
      })
      await act(async () => {
        row.dispatchEvent(event)
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    await pointer('pointerdown', 10)
    expect(engine.active?.id).equals(1)
    await pointer('pointerout', 20)
    await pointer('pointermove', 150)
    await pointer('pointerup', 150)
    expect(drops).deep.equals([1])
    expect(taps).deep.equals([])
    expect(engine.active).equals(null)
  })
  it('lets a short tap append and lets pre-hold movement scroll without adding or dropping', async () => {
    const { engine, row, taps, drops } = await setup()
    await touch(row, 'touchstart', 10)
    await touch(row, 'touchend', 10)
    expect(taps).deep.equals([1])
    await touch(row, 'touchstart', 10)
    const move = await touch(row, 'touchmove', 10, 50)
    expect(move.defaultPrevented).equals(false)
    await wait()
    expect(engine.active).equals(null)
    await touch(row, 'touchend', 150)
    expect(taps).deep.equals([1])
    expect(drops).deep.equals([])
  })
  it('holds, prevents native scroll after activation and drops once with synthetic click suppressed', async () => {
    const { engine, row, taps, drops } = await setup()
    await touch(row, 'touchstart', 10)
    await wait()
    expect(engine.active?.id).equals(1)
    const move = await touch(row, 'touchmove', 150)
    expect(move.defaultPrevented).equals(true)
    await touch(row, 'touchend', 150)
    await act(async () => {
      row.click()
    })
    expect(drops).deep.equals([1])
    expect(taps).deep.equals([])
  })
  it('cancels holds for escape, blur, multitouch, touch cancellation and unmount', async () => {
    const { engine, row, taps, drops } = await setup()
    await touch(row.querySelector('button')!, 'touchstart', 10)
    await wait()
    expect(engine.active).equals(null)
    for (const type of ['blur', 'escape', 'multi', 'touchcancel']) {
      await touch(row, 'touchstart', 10)
      await wait()
      await act(async () => {
        if (type === 'blur') window.dispatchEvent(new window.Event('blur'))
        if (type === 'escape')
          window.dispatchEvent(
            new window.KeyboardEvent('keydown', { key: 'Escape' })
          )
      })
      if (type === 'multi') await touch(row, 'touchmove', 20, 10, true)
      if (type === 'touchcancel') await touch(row, 'touchcancel', 10)
      await touch(row, 'touchend', 150)
      expect(engine.active).equals(null)
    }
    await touch(row, 'touchstart', 10)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    await wait()
    expect(engine.active).equals(null)
    expect(taps).deep.equals([])
    expect(drops).deep.equals([])
  }).timeout(5000)
  it('uses identical small clear circles and app primary fills and shadows in both themes', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    for (const theme of [tsBallpark, tsDark]) {
      await act(async () => {
        changeTheme(theme)
        root!.render(
          <ThemeProvider>
            <Button
              compact
              color={theme.scoringMenuActiveBackground}
              textColor={theme.scoringMenuActiveText}
              label="Save Rosters"
              accessibilityLabel="Save Rosters"
              onPress={() => undefined}
            />
            <RosterRemoveButton label="Clear P" onPress={() => undefined} />
          </ThemeProvider>
        )
      })
      const action = host.querySelector<HTMLElement>(
        '[aria-label="Save Rosters"]'
      )!
      const clear = host.querySelector<HTMLElement>('[aria-label="Clear P"]')!
      const css = window.getComputedStyle(action)
      expect(css.minHeight).equals('36px')
      expect(css.borderTopLeftRadius).equals('18px')
      expect(css.boxShadow).not.equals('none')
      expect(css.boxShadow).includes('8px')
      const expected = document.createElement('div')
      expected.style.backgroundColor = theme.scoringMenuActiveBackground
      expect(css.backgroundColor).equals(expected.style.backgroundColor)
      expect(clear.style.width).equals('32px')
      expect((clear.firstElementChild as HTMLElement).style.width).equals(
        '24px'
      )
    }
  })
})
