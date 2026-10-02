import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { gsBallpark } from '../theme/gsBallpark'
import { gsDark } from '../theme/gsDark'
import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { rosterNameProps } from './RosterEditor'
import { RosterSelector, rosterThumbWidth } from './RosterSelector'
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
  it('keeps a phone roster name on one line, and leaves the web wrap alone', function () {
    expect(rosterNameProps('web')).deep.equals({})
    for (const os of ['ios', 'android'])
      expect(rosterNameProps(os)).deep.equals({
        numberOfLines: 1,
        adjustsFontSizeToFit: true,
        minimumFontScale: 0.75
      })
  })

  it('sizes the thumb from the measured pill, not a percentage a phone misreads', function () {
    // Set Lineup / Set Defense on a Pixel: the pill measures 214 dp while the
    // row offered it 378 dp, and Yoga drew a `50%` thumb 189 dp wide.
    expect(rosterThumbWidth(214, 2, false)).equals(107)
    expect(rosterThumbWidth(214, 2, true)).equals(107)
    expect(rosterThumbWidth(300, 3, false)).equals(100)
    // Before the first layout a phone draws no thumb; the web's percentage
    // is resolved against the pill itself and is right from the start.
    expect(rosterThumbWidth(0, 2, false)).equals(0)
    expect(rosterThumbWidth(0, 2, true)).equals('50%')
    expect(rosterThumbWidth(0, 4, true)).equals('25%')
  })

  it('draws the web thumb over one segment before the pill is measured', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterSelector
            fitContent
            labels={['Set Lineup', 'Set Defense']}
            value={0}
            onChange={() => {}}
          />
        </ThemeProvider>
      )
    })
    const thumb = host.querySelector<HTMLElement>(
      '[data-testid="Roster selector thumb"]'
    )!
    expect(thumb.style.width).equals('50%')
    expect(thumb.style.position).equals('absolute')
  })

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

  it('shows captions in their own row above the pill and names tabs apart from their text', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const changes: number[] = []
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterSelector
            labels={['Owls', 'Hawks']}
            captions={['Away', 'Home']}
            accessibilityLabels={['Away Team', 'Home Team']}
            value={0}
            onChange={value => changes.push(value)}
          />
        </ThemeProvider>
      )
    })
    const captions = host.querySelector(
      '[data-testid="Roster selector captions"]'
    )!
    expect(captions.textContent).equals('AwayHome')
    const cells = Array.from(captions.children) as HTMLElement[]
    expect(cells.map(cell => cell.style.width)).deep.equals(['50%', '50%'])
    // The caption row comes before the pill, outside it.
    const away = host.querySelector('[aria-label="Away Team"]')!
    expect(
      captions.compareDocumentPosition(away) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    expect(captions.contains(away)).equals(false)
    expect(away.textContent).equals('Owls')
    expect(host.querySelector('[aria-label="Home Team"]')!.textContent).equals(
      'Hawks'
    )
    expect(host.querySelector('[aria-label="Owls"]')).equals(null)
    await act(async () => {
      host.querySelector<HTMLElement>('[aria-label="Home Team"]')!.click()
    })
    expect(changes).deep.equals([1])
  })

  for (const name of ['Owls', ''])
    it(`keeps two tabs with the same label ${JSON.stringify(name)} apart`, async function () {
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      const warnings: unknown[] = []
      const error = console.error
      console.error = (...args: unknown[]) => {
        warnings.push(args)
      }
      const changes: number[] = []
      try {
        await act(async () => {
          root!.render(
            <ThemeProvider>
              <RosterSelector
                labels={[name, name]}
                captions={['Away', 'Home']}
                accessibilityLabels={['Away Team', 'Home Team']}
                value={0}
                onChange={value => changes.push(value)}
              />
            </ThemeProvider>
          )
        })
        const tabs = host.querySelectorAll('[role="tab"]')
        expect(tabs).length(2)
        await act(async () => {
          host.querySelector<HTMLElement>('[aria-label="Home Team"]')!.click()
        })
        await act(async () => {
          host.querySelector<HTMLElement>('[aria-label="Away Team"]')!.click()
        })
        expect(changes).deep.equals([1, 0])
        expect(
          warnings.filter(args => String(args).includes('same key'))
        ).deep.equals([])
      } finally {
        console.error = error
      }
    })
})
