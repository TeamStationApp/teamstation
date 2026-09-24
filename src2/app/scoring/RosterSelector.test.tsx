import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { gsBallpark } from '../theme/gsBallpark'
import { gsDark } from '../theme/gsDark'
import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { RosterSelector } from './RosterSelector'
let root: Root | undefined
let host: HTMLDivElement
const Harness = (): React.ReactElement => {
  const [value, setValue] = useState(0)
  return (
    <ThemeProvider>
      <RosterSelector
        labels={['Away', 'Home']}
        value={value}
        onChange={setValue}
      />
    </ThemeProvider>
  )
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    changeTheme(gsBallpark)
  })
  root = undefined
})
describe('roster selector', function () {
  it('uses themed halves and supports tap, immediate swipe, child capture loss and cancellation', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<Harness />)
    })
    const wrapper = host.firstElementChild as HTMLElement
    wrapper.getBoundingClientRect = () => ({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      width: 320,
      height: 48,
      right: 330,
      bottom: 58,
      toJSON: () => ({})
    })
    const send = async (
      type: string,
      x: number,
      target: HTMLElement = wrapper
    ): Promise<void> => {
      await act(async () => {
        const e = new window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: 20
        })
        Object.defineProperty(e, 'pointerId', { value: 1 })
        target.dispatchEvent(e)
      })
    }
    const tab = (name: string): HTMLElement =>
      host.querySelector(`[aria-label="${name}"]`)!
    for (const theme of [gsBallpark, gsDark]) {
      await act(async () => {
        changeTheme(theme)
      })
      expect(tab('Away').style.width).equals('50%')
      expect(tab('Home').style.width).equals('50%')
      expect(
        (wrapper.firstElementChild as HTMLElement).style.backgroundColor
      ).equals(
        theme.scoringSelectorIdle === '#D9DDD6'
          ? 'rgb(217, 221, 214)'
          : 'rgb(87, 93, 84)'
      )
      await act(async () => {
        tab('Home').click()
      })
      expect(tab('Home').getAttribute('aria-selected')).equals('true')
      await act(async () => {
        tab('Away').click()
      })
      await send('pointerdown', 60, tab('Away'))
      await send('pointermove', 240)
      await send('lostpointercapture', 240, tab('Away'))
      await send('pointerup', 240)
      expect(tab('Home').getAttribute('aria-selected')).equals('true')
      // A compatibility click cannot undo the swipe by activating its starting tab.
      await act(async () => {
        tab('Away').click()
      })
      expect(tab('Home').getAttribute('aria-selected')).equals('true')
      await send('pointerdown', 240)
      await send('pointermove', 40)
      await send('pointercancel', 40)
      await send('pointerup', 40)
      expect(tab('Home').getAttribute('aria-selected')).equals('true')
      await send('pointerdown', 240)
      await send('pointermove', 40)
      await send('lostpointercapture', 40)
      await send('pointerup', 40)
      expect(tab('Home').getAttribute('aria-selected')).equals('true')
    }
  })
})
